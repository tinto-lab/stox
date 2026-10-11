import type { AgentResult, AnalysisResult, ViewContext } from '../shared/types'
import { ANALYZE_STOCK_SPEC, type AnalysisCallbacks, formatAnalysisForAgent, runStockAnalysis } from './analysis'
import { type ChatMessage, type ChatModel, type OnToolCall, runToolLoop } from './llm'
import { type ConsiderationStore, type Services, defaultServices } from './services'
import { DATA_TOOLS, type Tool, type ToolContext, argString, toolDispatch } from './tools'

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
  "printed right after your answer, so don't restate it. A bracketed reference like [TICKER on DATE] " +
  'in the user\'s message is a chart point they clicked; its data is appended after their message. ' +
  'Never guess the numbers of a reference whose data isn\'t there.'

/** AGENT_SYSTEM plus the standing considerations, read fresh each turn so
 * one remembered mid-session applies to this session's later turns too. */
function systemPrompt(store: ConsiderationStore): string {
  const considerations = store.list()
  if (!considerations.length) return AGENT_SYSTEM
  return (
    `${AGENT_SYSTEM}\n\nStanding considerations the user has asked you to always weigh when explaining ` +
    'why a price might be moving or assessing risk for a security (these persist across sessions):\n' +
    considerations.map((c) => `- ${c}`).join('\n')
  )
}

const REMEMBER_CONSIDERATION_SPEC = {
  name: 'remember_consideration',
  description:
    'Permanently remember a factor to always weigh when explaining why a price might be moving or ' +
    'assessing risk for a security.\n\nThis persists across sessions, not just this conversation. Call ' +
    'it when the user says something like "always consider X", "keep Y in mind when talking about ' +
    'risk", or "remember this for next time" -- not for one-off facts that aren\'t standing instructions.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
}

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

/** The data behind the chart-point references in a message, appended after
 * the user's text so `[AAPL on 2026-09-12]` means something to the model. */
export function formatViewContexts(contexts: ViewContext[]): string {
  const pct = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
  return contexts
    .map(({ token, code, range, bar, prevClose, rangeStartClose }) => {
      const parts = [
        `open ${bar.open}`,
        `high ${bar.high}`,
        `low ${bar.low}`,
        `close ${bar.close}`,
        `volume ${bar.volume}`
      ]
      if (prevClose) parts.push(`${pct((bar.close / prevClose - 1) * 100)} vs previous close`)
      parts.push(`${pct((bar.close / rangeStartClose - 1) * 100)} since the start of the ${range} chart`)
      return `${token} = ${code} daily bar ${bar.date}: ${parts.join(', ')}`
    })
    .join('\n')
}

export interface AskCallbacks {
  /** Chart points referenced in the question; see formatViewContexts. */
  contexts?: ViewContext[]
  /** Called right before each tool runs. */
  onToolCall?: OnToolCall
  /** Progress from the specialists when the model calls analyze_stock. */
  onAnalysisAgentStart?: AnalysisCallbacks['onAgentStart']
  onAnalysisToolCall?: AnalysisCallbacks['onToolCall']
  /** Called before each model call, then with the reasoning as it streams
   * in (DeepSeek thinking mode). */
  onReasoningStep?: () => void
  onReasoning?: (delta: string) => void
  /** The answer text as it streams in. */
  onText?: (delta: string) => void
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
  callbacks: AskCallbacks = {},
  services: Services = defaultServices
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
  const ctx: ToolContext = { market: services.market, knownUrls: articleUrlsIn(history) }

  const analyzeStock: Tool = {
    spec: ANALYZE_STOCK_SPEC,
    async run(args) {
      let analysis: AnalysisResult
      try {
        analysis = await runStockAnalysis(
          llm,
          argString(args, 'ticker'),
          {
            onAgentStart: callbacks.onAnalysisAgentStart,
            onToolCall: callbacks.onAnalysisToolCall,
            onReasoningStep: callbacks.onAnalysisReasoningStep,
            onReasoning: callbacks.onAnalysisReasoning,
            signal: callbacks.signal
          },
          services
        )
      } catch (e) {
        callbacks.signal?.throwIfAborted()
        return { text: `error: analysis error: ${e instanceof Error ? e.message : String(e)}` }
      }
      result.analysis = analysis
      for (const a of [...analysis.articles, ...analysis.geoArticles]) if (a.link) ctx.knownUrls.add(a.link)
      return { text: formatAnalysisForAgent(analysis) }
    }
  }

  const rememberConsideration: Tool = {
    spec: REMEMBER_CONSIDERATION_SPEC,
    async run(args) {
      const text = argString(args, 'text').trim()
      if (!text) return { text: 'error: nothing to remember' }
      services.considerations.add(text)
      return { text: `remembered: ${text}` }
    }
  }

  const tools: Tool[] = [
    DATA_TOOLS.get_stock_quote,
    DATA_TOOLS.get_stock_news,
    DATA_TOOLS.get_geopolitical_news,
    DATA_TOOLS.get_price_history,
    DATA_TOOLS.get_company_fundamentals,
    analyzeStock,
    DATA_TOOLS.read_article,
    rememberConsideration
  ]

  const text = callbacks.contexts?.length ? `${query}\n\n${formatViewContexts(callbacks.contexts)}` : query
  const messages: ChatMessage[] = [...history, { role: 'user', text }]
  result.text = await runToolLoop({
    llm,
    system: systemPrompt(services.considerations),
    messages,
    tools: tools.map((tool) => tool.spec),
    dispatch: toolDispatch(tools, ctx),
    maxRounds: MAX_AGENT_ROUNDS,
    budgetExhaustedNotice: BUDGET_EXHAUSTED_NOTICE,
    onToolCall: callbacks.onToolCall,
    onStep: callbacks.onReasoningStep,
    onReasoning: callbacks.onReasoning,
    onText: callbacks.onText,
    signal: callbacks.signal
  })

  history.splice(0, history.length, ...messages)
  trimHistory(history)
  return result
}
