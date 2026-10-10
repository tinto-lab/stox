import type { AnalysisResult, Article, Bar, Fundamentals, GeoArticle, Quote } from '../shared/types'
import { loadConsiderations } from './considerations'
import { type ChatModel, type Dispatch, type ToolLoopOptions, type ToolSpec, runToolLoop } from './llm'
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

export type SpecialistName = 'trend' | 'fundamentals' | 'news' | 'geopolitics'

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

/** MAX_TOOL_ROUNDS counts model calls, not tool calls: a model that reads
 * articles one at a time can spend every round on tools. Rather than
 * render that as "no answer", the budget running out forces one last call
 * with tools forbidden, so it writes up what it already gathered. */
/** One specialist's progress callbacks and cancellation, already bound to it. */
type SpecialistHooks = Pick<ToolLoopOptions, 'onToolCall' | 'onStep' | 'onReasoning' | 'signal'>

function runSpecialist(
  llm: ChatModel,
  system: string,
  tools: ToolSpec[],
  prompt: string,
  dispatch: Dispatch,
  hooks: SpecialistHooks
): Promise<string> {
  return runToolLoop({
    llm,
    system,
    messages: [{ role: 'user', text: prompt }],
    tools,
    dispatch,
    maxRounds: MAX_TOOL_ROUNDS,
    budgetExhaustedNotice: BUDGET_EXHAUSTED_NOTICE,
    ...hooks
  })
}

const NO_VERDICT = "Don't give a buy/sell verdict -- that's someone else's job."

export const TREND_AGENT_SYSTEM =
  "You are stox's trend analyst. Given a ticker, call get_price_history (days=90 is a good default " +
  'unless the question implies a different window) to see how the price has moved, and ' +
  "get_stock_quote for today's price and change. In 2-4 sentences, describe the trend: direction, " +
  'momentum, volatility, and where the price sits versus its recent high/low range. ' + NO_VERDICT

async function runTrendAgent(llm: ChatModel, ticker: string, hooks: SpecialistHooks) {
  let quotes: Quote[] = []
  let bars: Bar[] = []
  const dispatch: Dispatch = async (name, args) => {
    if (name === 'get_stock_quote') {
      const tickers = argStrings(args, 'tickers')
      const [text, found] = await runQuoteTool(tickers.length ? tickers : [ticker])
      if (found.length) quotes = found
      return text
    }
    if (name === 'get_price_history') {
      const [text, found] = await runHistoryTool(argString(args, 'ticker') || ticker, argNumber(args, 'days', 90))
      if (found.length) bars = found
      return text
    }
    return 'unknown tool'
  }
  const text = await runSpecialist(
    llm, TREND_AGENT_SYSTEM, [TOOL_SPECS.get_stock_quote, TOOL_SPECS.get_price_history],
    `Analyze the price trend for ${ticker}.`, dispatch, hooks
  )
  return { text, quotes, bars }
}

export const FUNDAMENTALS_AGENT_SYSTEM =
  "You are stox's fundamentals analyst. Given a ticker, call get_company_fundamentals and assess the " +
  "company's profitability and valuation in 2-4 sentences: margins, EBITDA, revenue/earnings growth, " +
  'and whether the valuation (P/E, PEG) looks rich or cheap. ' + NO_VERDICT

async function runFundamentalsAgent(llm: ChatModel, ticker: string, hooks: SpecialistHooks) {
  let fundamentals: Fundamentals | null = null
  const dispatch: Dispatch = async (name, args) => {
    if (name === 'get_company_fundamentals') {
      const [text, found] = await runFundamentalsTool(argString(args, 'ticker') || ticker)
      fundamentals = found ?? fundamentals
      return text
    }
    return 'unknown tool'
  }
  const text = await runSpecialist(
    llm, FUNDAMENTALS_AGENT_SYSTEM, [TOOL_SPECS.get_company_fundamentals],
    `Analyze the fundamentals for ${ticker}.`, dispatch, hooks
  )
  return { text, fundamentals: fundamentals as Fundamentals | null }
}

export const NEWS_AGENT_SYSTEM =
  "You are stox's news analyst. Given a ticker, call get_stock_news and summarize in 2-4 sentences the " +
  'sentiment and any notable catalysts or risks. ' + NO_VERDICT

async function runNewsAgent(llm: ChatModel, ticker: string, hooks: SpecialistHooks) {
  let articles: Article[] = []
  const knownUrls = new Set<string>()
  const dispatch: Dispatch = async (name, args) => {
    if (name === 'get_stock_news') {
      const tickers = argStrings(args, 'tickers')
      const [text, found] = await runNewsTool(tickers.length ? tickers : [ticker], argNumber(args, 'limit', 5))
      if (found.length) articles = found
      for (const a of found) if (a.link) knownUrls.add(a.link)
      return text
    }
    if (name === 'read_article') {
      const url = argString(args, 'url')
      return knownUrls.has(url) ? runReadArticleTool(url) : UNKNOWN_ARTICLE_URL_ERROR
    }
    return 'unknown tool'
  }
  const text = await runSpecialist(
    llm, NEWS_AGENT_SYSTEM, [TOOL_SPECS.get_stock_news, TOOL_SPECS.read_article],
    `Analyze recent news for ${ticker}.`, dispatch, hooks
  )
  return { text, articles }
}

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

async function runGeopoliticsAgent(llm: ChatModel, ticker: string, hooks: SpecialistHooks) {
  let articles: GeoArticle[] = []
  const knownUrls = new Set<string>()
  let searches = 0
  const dispatch: Dispatch = async (name, args) => {
    if (name === 'get_geopolitical_news') {
      // Counted before the first await: a turn's calls are dispatched
      // concurrently, and each must see the ones before it.
      if (searches >= MAX_GEO_SEARCHES) return GEO_SEARCH_BUDGET_NOTICE
      searches++
      const [text, found] = await runGeoNewsTool(argString(args, 'query') || ticker, argNumber(args, 'limit', 5))
      if (found.length) articles = found
      for (const a of found) if (a.link) knownUrls.add(a.link)
      return text
    }
    if (name === 'read_article') {
      const url = argString(args, 'url')
      return knownUrls.has(url) ? runReadArticleTool(url) : UNKNOWN_ARTICLE_URL_ERROR
    }
    return 'unknown tool'
  }
  const text = await runSpecialist(
    llm, GEOPOLITICS_AGENT_SYSTEM, [TOOL_SPECS.get_geopolitical_news, TOOL_SPECS.read_article],
    `Analyze geopolitical and macro risk for ${ticker}.`, dispatch, hooks
  )
  return { text, articles }
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
function aggregatorSystemPrompt(): string {
  const considerations = loadConsiderations()
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

/** Runs the four specialists concurrently (each hits a different data
 * source and none needs another's output), then the aggregator. A failed
 * specialist leaves a gap the aggregator works around rather than sinking
 * the other three; throws only if all four fail or the aggregator does. */
export async function runStockAnalysis(
  llm: ChatModel,
  ticker: string,
  { onAgentStart, onToolCall, onReasoningStep, onReasoning, signal }: AnalysisCallbacks = {}
): Promise<AnalysisResult> {
  const hooksFor = (agent: SpecialistName): SpecialistHooks => ({
    onToolCall: onToolCall && ((name, args) => onToolCall(agent, name, args)),
    onStep: onReasoningStep && (() => onReasoningStep(agent)),
    onReasoning: onReasoning && ((delta) => onReasoning(agent, delta)),
    signal
  })

  for (const name of ['trend', 'fundamentals', 'news', 'geopolitics'] as const) onAgentStart?.(name)
  const settled = await Promise.allSettled([
    runTrendAgent(llm, ticker, hooksFor('trend')),
    runFundamentalsAgent(llm, ticker, hooksFor('fundamentals')),
    runNewsAgent(llm, ticker, hooksFor('news')),
    runGeopoliticsAgent(llm, ticker, hooksFor('geopolitics'))
  ])
  signal?.throwIfAborted()
  const failures = settled.flatMap((s) => (s.status === 'rejected' ? [s.reason] : []))
  if (failures.length === settled.length) throw failures[0]
  const trend = orUnavailable(settled[0], (text) => ({ text, quotes: [], bars: [] }))
  const fundamentals = orUnavailable(settled[1], (text) => ({ text, fundamentals: null }))
  const news = orUnavailable(settled[2], (text) => ({ text, articles: [] }))
  const geopolitics = orUnavailable(settled[3], (text) => ({ text, articles: [] }))

  onAgentStart?.('aggregator')
  const prompt =
    `Ticker: ${ticker}\n\nTrend analysis:\n${trend.text}\n\nFundamentals analysis:\n${fundamentals.text}\n\n` +
    `News analysis:\n${news.text}\n\nGeopolitical analysis:\n${geopolitics.text}`
  onReasoningStep?.('aggregator')
  const verdict = await llm.complete({
    system: aggregatorSystemPrompt(),
    messages: [{ role: 'user', text: prompt }],
    onReasoning: onReasoning && ((delta) => onReasoning('aggregator', delta)),
    signal
  })

  return {
    ticker,
    trendText: trend.text,
    fundamentalsText: fundamentals.text,
    newsText: news.text,
    geopoliticsText: geopolitics.text,
    verdictText: verdict.text,
    quotes: trend.quotes,
    bars: trend.bars,
    articles: news.articles,
    geoArticles: geopolitics.articles,
    fundamentals: fundamentals.fundamentals
  }
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
