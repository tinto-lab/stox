import type { AgentResult, AnalysisResult } from '../shared/types'
import { ANALYZE_STOCK_SPEC, type AnalysisCallbacks, formatAnalysisForAgent, runStockAnalysis } from './analysis'
import { addConsideration, loadConsiderations } from './considerations'
import { type ChatMessage, type ChatModel, type Dispatch, type OnToolCall, type ToolSpec, runToolLoop } from './llm'
import {
  TOOL_SPECS,
  UNKNOWN_ARTICLE_URL_ERROR,
  argNumber,
  argString,
  argStrings,
  runFundamentalsTool,
  runGeoNewsTool,
  runHistoryTool,
  runNewsTool,
  runQuoteTool,
  runReadArticleTool
} from './tools'

/**
 * The chat agent: resolves a plain-English question ("what's apple trading
 * at?", "any news on tesla?") into tool calls and a short answer. Returns
 * data, never prints -- the app and the CLI each render the result their
 * own way.
 */

export const AGENT_SYSTEM =
  'You are stox, a terse terminal research assistant for stocks, crypto, and FX. Reply in the ' +
  "user's language. Map company names in any language or script to tickers yourself (Apple -> AAPL). " +
  'Fetch only what the question asks for: a bare ticker or company name just wants the price. For ' +
  'buy/sell/hold, price-prediction, risk, or full-analysis questions, call analyze_stock instead of the ' +
  'individual data tools. When the user asks whether to buy or sell, or where a price is headed, answer ' +
  'directly: give a clear Buy, Hold, or Sell call and, if asked for a prediction, a concrete price ' +
  "target or range with a time horizon, grounded in the analysis. Don't refuse or dodge these questions " +
  "and don't lecture about not giving financial advice -- the app already shows a disclaimer. " +
  "Answer in one or two short sentences -- a detailed panel of the tool data is " +
  "printed right after your answer, so don't restate it."

/** AGENT_SYSTEM plus the standing considerations, read fresh each turn so
 * one remembered mid-session applies to this session's later turns too. */
function systemPrompt(): string {
  const considerations = loadConsiderations()
  if (!considerations.length) return AGENT_SYSTEM
  return (
    `${AGENT_SYSTEM}\n\nStanding considerations the user has asked you to always weigh when explaining ` +
    'why a price might be moving or assessing risk for a security (these persist across sessions):\n' +
    considerations.map((c) => `- ${c}`).join('\n')
  )
}

const AGENT_TOOL_SPECS: Record<string, ToolSpec> = {
  remember_consideration: {
    name: 'remember_consideration',
    description:
      'Permanently remember a factor to always weigh when explaining why a price might be moving or ' +
      'assessing risk for a security.\n\nThis persists across sessions, not just this conversation. Call ' +
      'it when the user says something like "always consider X", "keep Y in mind when talking about ' +
      'risk", or "remember this for next time" -- not for one-off facts that aren\'t standing instructions.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  }
}

const ALL_TOOLS: ToolSpec[] = [
  TOOL_SPECS.get_stock_quote,
  TOOL_SPECS.get_stock_news,
  TOOL_SPECS.get_geopolitical_news,
  TOOL_SPECS.get_price_history,
  TOOL_SPECS.get_company_fundamentals,
  ANALYZE_STOCK_SPEC,
  TOOL_SPECS.read_article,
  ...Object.values(AGENT_TOOL_SPECS)
]

export const MAX_HISTORY_TURNS = 6

/** Model calls per question before the loop forces an answer. Generous --
 * a real question takes 2-3 -- it only stops a model that keeps calling
 * tools from spinning until the user hits ctrl+c. */
export const MAX_AGENT_ROUNDS = 10

const BUDGET_EXHAUSTED_NOTICE =
  "You've used up your tool-call budget for this question. Answer now using only what you've " +
  'already found above -- no more tool calls.'

/** Drops the oldest whole turns past MAX_HISTORY_TURNS. A turn always
 * starts at a user message, the only place a cut can't separate a tool
 * call from its result. */
export function trimHistory(history: ChatMessage[]): void {
  const starts = history.flatMap((m, i) => (m.role === 'user' ? [i] : []))
  if (starts.length > MAX_HISTORY_TURNS) history.splice(0, starts[starts.length - MAX_HISTORY_TURNS])
}

/**
 * Appends a /analyze run to `history` as if the agent had called
 * analyze_stock itself -- user message, the call, its result, a short
 * answer -- so follow-ups ("why is the risk high?", "read that tariff
 * article") can build on it.
 */
export function recordAnalysis(history: ChatMessage[], ticker: string, result: AnalysisResult): void {
  const callId = `analyze_${history.length}`
  history.push(
    { role: 'user', text: `/analyze ${ticker}` },
    { role: 'assistant', text: '', toolCalls: [{ id: callId, name: 'analyze_stock', args: { ticker } }] },
    { role: 'tool', toolCallId: callId, content: formatAnalysisForAgent(result) },
    { role: 'assistant', text: `Full analysis of ${ticker} is shown above.`, toolCalls: [] }
  )
  trimHistory(history)
}

/** Article urls from earlier tool results ("url: ..." lines), so
 * read_article's allow-list covers articles surfaced in earlier turns. */
export function articleUrlsIn(messages: ChatMessage[]): Set<string> {
  const urls = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'tool') continue
    for (const match of m.content.matchAll(/^url: (\S+)$/gm)) urls.add(match[1])
  }
  return urls
}

export interface AskCallbacks {
  /** Called right before each tool runs. */
  onToolCall?: OnToolCall
  /** Progress from the specialists when the model calls analyze_stock. */
  onAnalysisAgentStart?: AnalysisCallbacks['onAgentStart']
  onAnalysisToolCall?: AnalysisCallbacks['onToolCall']
  /** Called before each model call, then with the reasoning as it streams
   * in (DeepSeek thinking mode). */
  onReasoningStep?: () => void
  onReasoning?: (delta: string) => void
  /** The same, from the specialists when the model calls analyze_stock. */
  onAnalysisReasoningStep?: AnalysisCallbacks['onReasoningStep']
  onAnalysisReasoning?: AnalysisCallbacks['onReasoning']
  signal?: AbortSignal
}

/**
 * Answers one question. `history` holds earlier turns of the same
 * conversation (so "what about its news?" resolves "its"); on success this
 * turn is appended to it and it's trimmed, on failure it's left untouched
 * so a failed turn doesn't pollute the next one. Throws on an LLM failure.
 */
export async function askAgent(
  llm: ChatModel,
  query: string,
  history: ChatMessage[] = [],
  callbacks: AskCallbacks = {}
): Promise<AgentResult> {
  const result: AgentResult = {
    text: '',
    quotes: [],
    articles: [],
    geoArticles: [],
    bars: [],
    fundamentals: null,
    analysis: null
  }
  // Only urls a news tool actually returned (this turn or one still in
  // history) may be read -- the model can't direct a fetch of any url.
  const knownUrls = articleUrlsIn(history)

  const dispatch: Dispatch = async (name, args) => {
    switch (name) {
      case 'get_stock_quote': {
        const [text] = await runQuoteTool(argStrings(args, 'tickers'))
        return text
      }
      case 'get_stock_news': {
        const [text, articles] = await runNewsTool(argStrings(args, 'tickers'), argNumber(args, 'limit', 5))
        for (const a of articles) if (a.link) knownUrls.add(a.link)
        return text
      }
      case 'get_geopolitical_news': {
        const [text, articles] = await runGeoNewsTool(argString(args, 'query'), argNumber(args, 'limit', 5))
        for (const a of articles) if (a.link) knownUrls.add(a.link)
        return text
      }
      case 'get_price_history': {
        const [text] = await runHistoryTool(argString(args, 'ticker'), argNumber(args, 'days', 30))
        return text
      }
      case 'get_company_fundamentals': {
        const [text] = await runFundamentalsTool(argString(args, 'ticker'))
        return text
      }
      case 'analyze_stock': {
        let analysis: AnalysisResult
        try {
          analysis = await runStockAnalysis(llm, argString(args, 'ticker'), {
            onAgentStart: callbacks.onAnalysisAgentStart,
            onToolCall: callbacks.onAnalysisToolCall,
            onReasoningStep: callbacks.onAnalysisReasoningStep,
            onReasoning: callbacks.onAnalysisReasoning,
            signal: callbacks.signal
          })
        } catch (e) {
          callbacks.signal?.throwIfAborted()
          return `error: analysis error: ${e instanceof Error ? e.message : String(e)}`
        }
        result.analysis = analysis
        for (const a of [...analysis.articles, ...analysis.geoArticles]) if (a.link) knownUrls.add(a.link)
        return formatAnalysisForAgent(analysis)
      }
      case 'read_article': {
        const url = argString(args, 'url')
        return knownUrls.has(url) ? runReadArticleTool(url) : UNKNOWN_ARTICLE_URL_ERROR
      }
      case 'remember_consideration': {
        const text = argString(args, 'text').trim()
        if (!text) return 'error: nothing to remember'
        addConsideration(text)
        return `remembered: ${text}`
      }
      default:
        return 'unknown tool'
    }
  }

  const messages: ChatMessage[] = [...history, { role: 'user', text: query }]
  result.text = await runToolLoop({
    llm,
    system: systemPrompt(),
    messages,
    tools: ALL_TOOLS,
    dispatch,
    maxRounds: MAX_AGENT_ROUNDS,
    budgetExhaustedNotice: BUDGET_EXHAUSTED_NOTICE,
    onToolCall: callbacks.onToolCall,
    onStep: callbacks.onReasoningStep,
    onReasoning: callbacks.onReasoning,
    signal: callbacks.signal
  })

  history.splice(0, history.length, ...messages)
  trimHistory(history)
  return result
}
