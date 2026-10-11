import type { AnalysisResult } from '../shared/types'
import { type ChatModel, type ToolLoopOptions, type ToolSpec, runToolLoop } from './llm'
import { type ConsiderationStore, type Services, defaultServices } from './services'
import { DATA_TOOLS, type Tool, type ToolArtifacts, type ToolContext, toolDispatch } from './tools'

/**
 * Multi-agent stock analysis: trend, fundamentals, news and geopolitics
 * specialists feeding a risk-assessment aggregator.
 *
 * Each specialist is its own LLM conversation with a narrow system prompt
 * and its own slice of the tools, so a change to how one analyzes doesn't
 * ripple into the others. The aggregator sees only their written findings,
 * not the raw data, and has no tools -- it synthesizes, it doesn't
 * investigate. All five share one ChatModel.
 */

export const MAX_TOOL_ROUNDS = 6

const BUDGET_EXHAUSTED_NOTICE =
  "You've used up your tool-call budget. Answer now, in 2-4 sentences, using only what you've " +
  'already found above -- no more tool calls.'

export interface AnalysisCallbacks {
  /** Called with each stage's name: the four specialists together as they
   * start (they run concurrently), then "aggregator" once they're done. */
  onAgentStart?: (name: SpecialistName | 'aggregator') => void
  /** Like the chat agent's onToolCall, plus which specialist made the call. */
  onToolCall?: (agent: SpecialistName, name: string, args: Record<string, unknown>) => void
  /** Like ToolLoopOptions' onStep/onReasoning, plus which agent it's about
   * -- the specialists think concurrently, the aggregator last. */
  onReasoningStep?: (agent: SpecialistName | 'aggregator') => void
  onReasoning?: (agent: SpecialistName | 'aggregator', delta: string) => void
  signal?: AbortSignal
}

/** One specialist's progress callbacks and cancellation, already bound to it. */
type SpecialistHooks = Pick<ToolLoopOptions, 'onToolCall' | 'onStep' | 'onReasoning' | 'signal'>

const NO_VERDICT = "Don't give a buy/sell verdict -- that's someone else's job."

export const TREND_AGENT_SYSTEM =
  "You are stox's trend analyst. Given a ticker, call get_price_history (days=90 is a good default " +
  'unless the question implies a different window) to see how the price has moved, and ' +
  "get_stock_quote for today's price and change. In 2-4 sentences, describe the trend: direction, " +
  'momentum, volatility, and where the price sits versus its recent high/low range. ' + NO_VERDICT

export const FUNDAMENTALS_AGENT_SYSTEM =
  "You are stox's fundamentals analyst. Given a ticker, call get_company_fundamentals and assess the " +
  "company's profitability and valuation in 2-4 sentences: margins, EBITDA, revenue/earnings growth, " +
  'and whether the valuation (P/E, PEG) looks rich or cheap. ' + NO_VERDICT

export const NEWS_AGENT_SYSTEM =
  "You are stox's news analyst. Given a ticker, call get_stock_news and summarize in 2-4 sentences the " +
  'sentiment and any notable catalysts or risks. ' + NO_VERDICT

export const MAX_GEO_SEARCHES = 3

export const GEOPOLITICS_AGENT_SYSTEM =
  "You are stox's geopolitics analyst. Given a ticker, work out which countries, supply chains, " +
  'commodities, and regulators the company is exposed to, then search get_geopolitical_news for those ' +
  `angles. You have a budget of ${MAX_GEO_SEARCHES} searches: pick the angles that matter most, keep ` +
  'each query to a few key words (long queries tend to match nothing), and make all the searches ' +
  'together in your first response. In 2-4 sentences, explain what geopolitical or macro forces could ' +
  "move this stock and how -- say plainly if nothing relevant turns up. Don't mention your search " +
  'budget. ' + NO_VERDICT

export const GEO_SEARCH_BUDGET_NOTICE =
  `error: you've used up your ${MAX_GEO_SEARCHES} searches for this run -- work with what you already ` +
  'have instead of searching again'

/** `tool`, refusing every call past the first `max` with `notice`. The
 * count is taken before the first await: a turn's calls are dispatched
 * concurrently, and each must see the ones before it. */
function limitCalls(tool: Tool, max: number, notice: string): Tool {
  let used = 0
  return {
    ...tool,
    async run(args, ctx) {
      if (used >= max) return { text: notice }
      used++
      return tool.run(args, ctx)
    }
  }
}

type TextField = 'trendText' | 'fundamentalsText' | 'newsText' | 'geopoliticsText'

/**
 * A specialist is data: a name, a narrow prompt and its own slice of the
 * tools. runStockAnalysis runs whatever is in SPECIALISTS, so adding one
 * means adding an entry here (plus its field on AnalysisResult).
 */
interface Specialist {
  name: string
  /** How the aggregator is told whose write-up it's reading. */
  label: string
  /** Where its write-up lands in the AnalysisResult. */
  textField: TextField
  system: string
  prompt(ticker: string): string
  /** Called per run, so a tool with a budget starts with all of it. */
  tools(): Tool[]
  /** Used when the model gives get_price_history no `days`. */
  historyDays?: number
}

export type SpecialistName = 'trend' | 'fundamentals' | 'news' | 'geopolitics'

const SPECIALISTS: (Specialist & { name: SpecialistName })[] = [
  {
    name: 'trend',
    label: 'Trend analysis',
    textField: 'trendText',
    system: TREND_AGENT_SYSTEM,
    prompt: (ticker) => `Analyze the price trend for ${ticker}.`,
    tools: () => [DATA_TOOLS.get_stock_quote, DATA_TOOLS.get_price_history],
    historyDays: 90
  },
  {
    name: 'fundamentals',
    label: 'Fundamentals analysis',
    textField: 'fundamentalsText',
    system: FUNDAMENTALS_AGENT_SYSTEM,
    prompt: (ticker) => `Analyze the fundamentals for ${ticker}.`,
    tools: () => [DATA_TOOLS.get_company_fundamentals]
  },
  {
    name: 'news',
    label: 'News analysis',
    textField: 'newsText',
    system: NEWS_AGENT_SYSTEM,
    prompt: (ticker) => `Analyze recent news for ${ticker}.`,
    tools: () => [DATA_TOOLS.get_stock_news, DATA_TOOLS.read_article]
  },
  {
    name: 'geopolitics',
    label: 'Geopolitical analysis',
    textField: 'geopoliticsText',
    system: GEOPOLITICS_AGENT_SYSTEM,
    prompt: (ticker) => `Analyze geopolitical and macro risk for ${ticker}.`,
    tools: () => [
      limitCalls(DATA_TOOLS.get_geopolitical_news, MAX_GEO_SEARCHES, GEO_SEARCH_BUDGET_NOTICE),
      DATA_TOOLS.read_article
    ]
  }
]

/** A specialist's write-up plus whatever data its tools turned up. */
type Findings = { text: string } & Partial<ToolArtifacts>

const hasData = (data: unknown): boolean => (Array.isArray(data) ? data.length > 0 : data != null)

/** MAX_TOOL_ROUNDS counts model calls, not tool calls: a model that reads
 * articles one at a time can spend every round on tools. Rather than
 * render that as "no answer", the budget running out forces one last call
 * with tools forbidden, so it writes up what it already gathered. */
async function runSpecialist(
  llm: ChatModel,
  specialist: Specialist,
  ticker: string,
  services: Services,
  hooks: SpecialistHooks
): Promise<Findings> {
  const tools = specialist.tools()
  const ctx: ToolContext = { market: services.market, knownUrls: new Set(), ticker, historyDays: specialist.historyDays }
  const found: Partial<ToolArtifacts> = {}
  const text = await runToolLoop({
    llm,
    system: specialist.system,
    messages: [{ role: 'user', text: specialist.prompt(ticker) }],
    tools: tools.map((tool) => tool.spec),
    // The latest non-empty result of each data tool is what the UI shows.
    dispatch: toolDispatch(tools, ctx, (tool, { data }) => {
      if (tool.produces && hasData(data)) (found as Record<string, unknown>)[tool.produces] = data
    }),
    maxRounds: MAX_TOOL_ROUNDS,
    budgetExhaustedNotice: BUDGET_EXHAUSTED_NOTICE,
    ...hooks
  })
  return { text, ...found }
}

export const AGGREGATOR_SYSTEM =
  "You are stox's aggregator. You're given a trend analysis, a fundamentals analysis, a news analysis, " +
  "and a geopolitical analysis for one ticker, each written by a specialist who didn't see the others' " +
  'work and has no tools of its own. Synthesize a risk assessment: 2-3 bullish factors, 2-3 ' +
  'bearish/risk factors, an overall risk level (low/medium/high), and a directional lean ' +
  "(favorable/neutral/cautious). Fold in the geopolitical analysis where it's actually relevant -- " +
  "don't force a connection if that specialist found nothing notable. If an analysis is marked " +
  "unavailable, work from the others and say briefly what's missing. Then give a clear verdict line " +
  '(Buy, Hold, or Sell) with a one-line reason, and a price outlook: a target price or range over ' +
  "roughly the next 3-6 months with your confidence (low/medium/high). Commit to a call -- don't hedge " +
  'it away or refuse; the user sees a separate disclaimer. Weigh any standing considerations listed ' +
  'below. Keep it tight: plain text, short bullet lines, no markdown headers. The user only sees ' +
  'your assessment, not the four source analyses, so carry the key facts and figures that support it.'

/** Read fresh each run, so a consideration remembered mid-session applies immediately. */
function aggregatorSystemPrompt(store: ConsiderationStore): string {
  const considerations = store.list()
  if (!considerations.length) return AGGREGATOR_SYSTEM
  return `${AGGREGATOR_SYSTEM}\n\nStanding considerations to weigh:\n${considerations.map((c) => `- ${c}`).join('\n')}`
}

/** A specialist's result, or -- if it failed -- a stand-in with no data
 * whose text says so, for the aggregator and the user to see. */
function orUnavailable<T>(settled: PromiseSettledResult<T>, empty: (text: string) => T): T {
  if (settled.status === 'fulfilled') return settled.value
  const reason = settled.reason instanceof Error ? settled.reason.message : String(settled.reason)
  return empty(`Unavailable -- this analysis failed: ${reason}`)
}

/** Runs the specialists concurrently (each hits a different data
 * source and none needs another's output), then the aggregator. A failed
 * specialist leaves a gap the aggregator works around rather than sinking
 * the others; throws only if all of them fail or the aggregator does. */
export async function runStockAnalysis(
  llm: ChatModel,
  ticker: string,
  { onAgentStart, onToolCall, onReasoningStep, onReasoning, signal }: AnalysisCallbacks = {},
  services: Services = defaultServices
): Promise<AnalysisResult> {
  const hooksFor = (agent: SpecialistName): SpecialistHooks => ({
    onToolCall: onToolCall && ((name, args) => onToolCall(agent, name, args)),
    onStep: onReasoningStep && (() => onReasoningStep(agent)),
    onReasoning: onReasoning && ((delta) => onReasoning(agent, delta)),
    signal
  })

  for (const { name } of SPECIALISTS) onAgentStart?.(name)
  const settled = await Promise.allSettled(
    SPECIALISTS.map((specialist) => runSpecialist(llm, specialist, ticker, services, hooksFor(specialist.name)))
  )
  signal?.throwIfAborted()
  const failures = settled.flatMap((s) => (s.status === 'rejected' ? [s.reason] : []))
  if (failures.length === settled.length) throw failures[0]
  const findings = settled.map((s): Findings => orUnavailable(s, (text) => ({ text })))

  onAgentStart?.('aggregator')
  const prompt =
    `Ticker: ${ticker}\n\n` +
    SPECIALISTS.map((specialist, i) => `${specialist.label}:\n${findings[i].text}`).join('\n\n')
  onReasoningStep?.('aggregator')
  const verdict = await llm.complete({
    system: aggregatorSystemPrompt(services.considerations),
    messages: [{ role: 'user', text: prompt }],
    onReasoning: onReasoning && ((delta) => onReasoning('aggregator', delta)),
    signal
  })

  const texts = {} as Record<TextField, string>
  SPECIALISTS.forEach((specialist, i) => (texts[specialist.textField] = findings[i].text))
  const data: ToolArtifacts = { quotes: [], bars: [], articles: [], geoArticles: [], fundamentals: null }
  for (const { text: _text, ...artifacts } of findings) Object.assign(data, artifacts)
  return { ticker, ...texts, verdictText: verdict.text, ...data }
}

/**
 * An analysis as tool-result text for the chat agent -- both when it calls
 * analyze_stock itself and when a /analyze run is recorded into history.
 * Source urls go on "url: ..." lines, the same format the news tools use,
 * so read_article's allow-list picks them up for follow-ups.
 */
export function formatAnalysisForAgent(result: AnalysisResult): string {
  let text =
    `trend: ${result.trendText}\n\nfundamentals: ${result.fundamentalsText}\n\nnews: ${result.newsText}\n\n` +
    `geopolitics: ${result.geopoliticsText}\n\nrisk_assessment: ${result.verdictText}`
  const sources = [...result.articles, ...result.geoArticles].filter((a) => a.link)
  if (sources.length) text += '\n\nsources:\n' + sources.map((a) => `title: ${a.title}\nurl: ${a.link}`).join('\n')
  return text
}

export const ANALYZE_STOCK_SPEC: ToolSpec = {
  name: 'analyze_stock',
  description:
    'Run a full multi-agent analysis of one ticker: dedicated trend, fundamentals, news, and geopolitics ' +
    'agents each produce a focused analysis, then an aggregator combines them into a risk assessment ' +
    '(bullish/bearish factors, an overall risk level, a directional lean, a Buy/Hold/Sell verdict, and a ' +
    'price outlook).\n\nUse this for buy/sell/hold, price-prediction, or risk questions, or requests for a ' +
    "full analysis -- it's slower than the individual data tools (it makes several LLM calls), so don't " +
    'call it just for a simple price or news lookup.',
  parameters: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] }
}
