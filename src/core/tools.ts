import { normalize } from '../shared/symbols'
import type { AnalysisResult, Article, Bar, Fundamentals, GeoArticle, Quote } from '../shared/types'
import { isRedirectLink, mapLimit } from './gnews'
import type { Dispatch, ToolSpec } from './llm'
import type { MarketData } from './services'

/**
 * The data-lookup tools: quotes, news, price history, fundamentals,
 * world/geopolitical news and full-article text. Used by the chat agent
 * and, a narrower slice each, by the analysis specialists -- kept here,
 * neutral of both.
 *
 * Each run* function returns the tool-result text the model sees plus the
 * data itself, which the UI renders. Failures come back as "error: ..."
 * text rather than throwing, so the model can work around them.
 *
 * A Tool bundles a spec with its implementation, so an agent is given a
 * list of Tools and toolDispatch() routes calls to them -- adding a tool
 * means adding an entry here, not editing every agent's dispatcher.
 */

const MAX_ARTICLE_FETCH_WORKERS = 5

const errorText = (e: unknown): string => `error: ${e instanceof Error ? e.message : String(e)}`
const f2 = (v: number): string => v.toFixed(2)
const signed = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`

// -- tool definitions (JSON Schema) --

const tickersParam = { type: 'array', items: { type: 'string' } }

const TOOL_SPECS = {
  get_stock_quote: {
    name: 'get_stock_quote',
    description:
      'Look up real-time price quotes for one or more tickers.\n\nBare symbols default to the US exchange ' +
      '(AAPL, TSLA). Use SYMBOL.EXCHANGE for anything else (BMW.XETRA, BTC-USD.CC, EURUSD.FOREX).',
    parameters: { type: 'object', properties: { tickers: tickersParam }, required: ['tickers'] }
  },
  get_price_history: {
    name: 'get_price_history',
    description:
      'Look up historical daily OHLC prices for one ticker.\n\n`days` is how far back to look from today ' +
      '(default 30). Use this for questions about past performance or price trends over time, not for the ' +
      'current price. Bare symbols default to the US exchange (AAPL, TSLA).',
    parameters: {
      type: 'object',
      properties: { ticker: { type: 'string' }, days: { type: 'integer', default: 30 } },
      required: ['ticker']
    }
  },
  get_company_fundamentals: {
    name: 'get_company_fundamentals',
    description:
      'Look up profitability and valuation fundamentals for one ticker.\n\nCovers EBITDA, revenue, margins, ' +
      "ROE/ROA, growth rates, P/E, and analyst target price. Use this for questions about a company's " +
      'financial health or valuation, not its current price or news. Bare symbols default to the US ' +
      'exchange (AAPL, TSLA).',
    parameters: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] }
  },
  get_stock_news: {
    name: 'get_stock_news',
    description:
      "Look up recent news for one or more tickers, with each article's full text.\n\nUse this for " +
      "questions about news, headlines, or what's going on with a company or stock -- separate from its " +
      'price. Bare symbols default to the US exchange (AAPL, TSLA).',
    parameters: {
      type: 'object',
      properties: { tickers: tickersParam, limit: { type: 'integer', default: 5 } },
      required: ['tickers']
    }
  },
  get_geopolitical_news: {
    name: 'get_geopolitical_news',
    description:
      'Search world/general news for geopolitical or macro developments -- tariffs, sanctions, export ' +
      'controls, elections, central-bank decisions, regional conflicts, commodity shocks -- that ' +
      "aren't scoped to one ticker the way get_stock_news is.\n\n`query` is a few key words, not a " +
      'ticker symbol -- every word must match, so keep it short (e.g. "Taiwan chip export controls", ' +
      '"Fed rate decision"). Use OR for alternatives and quotes for exact phrases: tariffs OR "export ' +
      'controls". Searches English-language news from the past week, best matches first.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer', default: 5 } },
      required: ['query']
    }
  },
  read_article: {
    name: 'read_article',
    description:
      "Read the full text of one news article, given its exact url.\n\nNews results already include each " +
      "article's full text; call this only when an article's text fell back to a short summary and that " +
      "isn't enough. Only urls that get_stock_news or get_geopolitical_news returned in this conversation work.",
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  }
} satisfies Record<string, ToolSpec>

export const UNKNOWN_ARTICLE_URL_ERROR =
  'error: url must be one get_stock_news or get_geopolitical_news returned in this conversation'

// -- argument coercion: model-supplied args are untrusted JSON --

export function argString(args: Record<string, unknown>, key: string, fallback = ''): string {
  const v = args[key]
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback
}

export function argNumber(args: Record<string, unknown>, key: string, fallback: number): number {
  const n = Number(args[key])
  return args[key] !== undefined && args[key] !== null && Number.isFinite(n) ? n : fallback
}

export function argStrings(args: Record<string, unknown>, key: string): string[] {
  const v = args[key]
  if (Array.isArray(v)) return v.map(String).filter(Boolean)
  return typeof v === 'string' && v ? [v] : []
}

// -- implementations --

/** Full article text per link, fetched concurrently; null where it fails,
 * so callers fall back to the provider's own summary for that one. */
async function fetchBodies(market: MarketData, links: string[]): Promise<(string | null)[]> {
  return mapLimit(links, MAX_ARTICLE_FETCH_WORKERS, async (link) => {
    if (!link || isRedirectLink(link)) return null
    try {
      return await market.articleText(link)
    } catch {
      return null
    }
  })
}

export async function runQuoteTool(market: MarketData, tickers: string[]): Promise<[string, Quote[]]> {
  if (!tickers.length) return ['error: no tickers given', []]
  let result
  try {
    result = await market.quotes(tickers)
  } catch (e) {
    return [errorText(e), []]
  }
  const lines = result.quotes.map(
    (q) =>
      `${q.code}: price=${f2(q.price)} change=${signed(q.change)} change_pct=${signed(q.percent)}% ` +
      `open=${f2(q.open)} high=${f2(q.high)} low=${f2(q.low)} prev_close=${f2(q.prevClose)} volume=${q.volume.toFixed(0)}`
  )
  lines.push(...result.missing.map((code) => `${code}: no data (unknown symbol?)`))
  return [lines.join('\n') || 'no data', result.quotes]
}

/** A summary plus the latest bar, not every row, so a long lookback
 * doesn't flood the model with raw numbers. */
export async function runHistoryTool(market: MarketData, ticker: string, days = 30): Promise<[string, Bar[]]> {
  let bars: Bar[]
  try {
    bars = await market.bars(ticker, days)
  } catch (e) {
    return [errorText(e), []]
  }
  if (!bars.length) return ['no historical data found', []]

  const first = bars[0]
  const last = bars[bars.length - 1]
  const change = last.close - first.close
  const percent = first.close ? (change / first.close) * 100 : 0
  const high = Math.max(...bars.map((b) => b.high))
  const low = Math.min(...bars.map((b) => b.low))
  const summary =
    `${normalize(ticker)} ${first.date.slice(0, 10)}..${last.date.slice(0, 10)} (${bars.length} bars): ` +
    `start=${f2(first.close)} end=${f2(last.close)} change=${signed(change)} change_pct=${signed(percent)}% ` +
    `period_high=${f2(high)} period_low=${f2(low)}`
  const latest =
    `latest: date=${last.date.slice(0, 10)} open=${f2(last.open)} high=${f2(last.high)} ` +
    `low=${f2(last.low)} close=${f2(last.close)} volume=${last.volume.toFixed(0)}`
  return [`${summary}\n${latest}`, bars]
}

export async function runFundamentalsTool(market: MarketData, ticker: string): Promise<[string, Fundamentals | null]> {
  let f: Fundamentals
  try {
    f = await market.fundamentals(ticker)
  } catch (e) {
    return [errorText(e), null]
  }
  const pct = (v: number | null): string => (v === null ? 'NA' : `${(v * 100).toFixed(2)}%`)
  const n = (v: number | null, digits = 2): string => (v === null ? 'NA' : v.toFixed(digits))
  const text =
    `${f.code} (${f.name ?? '?'}) sector=${f.sector ?? ''} industry=${f.industry ?? ''} market_cap=${n(f.marketCap, 0)}\n` +
    `ebitda=${n(f.ebitda, 0)} revenue_ttm=${n(f.revenueTtm, 0)} eps=${n(f.eps)}\n` +
    `profit_margin=${pct(f.profitMargin)} operating_margin=${pct(f.operatingMargin)} roe=${pct(f.roe)} roa=${pct(f.roa)}\n` +
    `revenue_growth_yoy=${pct(f.revenueGrowth)} earnings_growth_yoy=${pct(f.earningsGrowth)}\n` +
    `pe_ratio=${n(f.trailingPE)} forward_pe=${n(f.forwardPE)} peg_ratio=${n(f.pegRatio)} ` +
    `dividend_yield=${pct(f.dividendYield)} analyst_target_price=${n(f.targetMeanPrice)}`
  return [text, f]
}

/** Each article block carries its full text (fetched from its own url),
 * falling back to the provider's summary where the fetch fails. */
export async function runNewsTool(market: MarketData, tickers: string[], limit = 5): Promise<[string, Article[]]> {
  if (!tickers.length) return ['error: no tickers given', []]
  let articles: Article[]
  try {
    articles = await market.news(tickers, limit)
  } catch (e) {
    return [errorText(e), []]
  }
  if (!articles.length) return ['no recent news found', []]
  const bodies = await fetchBodies(market, articles.map((a) => a.link))
  const blocks = articles.map(
    (a, i) => `date: ${(a.date || '').slice(0, 10)}\ntitle: ${a.title}\nurl: ${a.link}\ntext: ${bodies[i] || a.summary}`
  )
  return [blocks.join('\n---\n'), articles]
}

export async function runGeoNewsTool(market: MarketData, query: string, limit = 5): Promise<[string, GeoArticle[]]> {
  if (!query.trim()) return ['error: no query given', []]
  let articles: GeoArticle[]
  try {
    articles = await market.geoNews(query, limit)
  } catch (e) {
    return [errorText(e), []]
  }
  if (!articles.length) return ['no relevant world news found', []]
  const bodies = await fetchBodies(market, articles.map((a) => a.link))
  const blocks = articles.map(
    (a, i) =>
      `date: ${(a.date || '').slice(0, 10)}\ncountry: ${a.country || '?'}\nsentiment: ${a.sentiment || '?'}\n` +
      `title: ${a.title}\nurl: ${a.link}\ntext: ${bodies[i] || a.summary}`
  )
  return [blocks.join('\n---\n'), articles]
}

export async function runReadArticleTool(market: MarketData, url: string): Promise<string> {
  try {
    return await market.articleText(url)
  } catch (e) {
    return errorText(e)
  }
}

// -- tools: spec + implementation --

/** The pieces of an AnalysisResult that tool data can fill in. */
export type ToolArtifacts = Pick<AnalysisResult, 'quotes' | 'bars' | 'fundamentals' | 'articles' | 'geoArticles'>

export interface ToolContext {
  market: MarketData
  /** Article urls a news tool has returned (in this run, or an earlier turn
   * of the conversation) -- the only ones read_article will fetch. */
  knownUrls: Set<string>
  /** The ticker a specialist is about: fills in arguments the model left out. */
  ticker?: string
  /** How far back get_price_history looks when the model gives no `days`. */
  historyDays?: number
}

export interface ToolOutcome {
  /** What the model sees. */
  text: string
  /** The data behind it, for the UI. */
  data?: unknown
}

export interface Tool {
  spec: ToolSpec
  /** Which AnalysisResult field this tool's data fills, if any. */
  produces?: keyof ToolArtifacts
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>
}

const tickersOf = (args: Record<string, unknown>, ctx: ToolContext): string[] => {
  const tickers = argStrings(args, 'tickers')
  return tickers.length ? tickers : ctx.ticker ? [ctx.ticker] : []
}
const tickerOf = (args: Record<string, unknown>, ctx: ToolContext): string => argString(args, 'ticker') || ctx.ticker || ''
const remember = (ctx: ToolContext, articles: { link: string }[]): void => {
  for (const a of articles) if (a.link) ctx.knownUrls.add(a.link)
}

const quoteTool: Tool = {
  spec: TOOL_SPECS.get_stock_quote,
  produces: 'quotes',
  async run(args, ctx) {
    const [text, data] = await runQuoteTool(ctx.market, tickersOf(args, ctx))
    return { text, data }
  }
}

const historyTool: Tool = {
  spec: TOOL_SPECS.get_price_history,
  produces: 'bars',
  async run(args, ctx) {
    const [text, data] = await runHistoryTool(ctx.market, tickerOf(args, ctx), argNumber(args, 'days', ctx.historyDays ?? 30))
    return { text, data }
  }
}

const fundamentalsTool: Tool = {
  spec: TOOL_SPECS.get_company_fundamentals,
  produces: 'fundamentals',
  async run(args, ctx) {
    const [text, data] = await runFundamentalsTool(ctx.market, tickerOf(args, ctx))
    return { text, data }
  }
}

const newsTool: Tool = {
  spec: TOOL_SPECS.get_stock_news,
  produces: 'articles',
  async run(args, ctx) {
    const [text, data] = await runNewsTool(ctx.market, tickersOf(args, ctx), argNumber(args, 'limit', 5))
    remember(ctx, data)
    return { text, data }
  }
}

const geoNewsTool: Tool = {
  spec: TOOL_SPECS.get_geopolitical_news,
  produces: 'geoArticles',
  async run(args, ctx) {
    const [text, data] = await runGeoNewsTool(ctx.market, argString(args, 'query') || ctx.ticker || '', argNumber(args, 'limit', 5))
    remember(ctx, data)
    return { text, data }
  }
}

const readArticleTool: Tool = {
  spec: TOOL_SPECS.read_article,
  async run(args, ctx) {
    const url = argString(args, 'url')
    return { text: ctx.knownUrls.has(url) ? await runReadArticleTool(ctx.market, url) : UNKNOWN_ARTICLE_URL_ERROR }
  }
}

/** Every data tool by name; agents pick the ones they use. */
export const DATA_TOOLS = {
  get_stock_quote: quoteTool,
  get_price_history: historyTool,
  get_company_fundamentals: fundamentalsTool,
  get_stock_news: newsTool,
  get_geopolitical_news: geoNewsTool,
  read_article: readArticleTool
} as const satisfies Record<string, Tool>

/**
 * Routes the model's tool calls to `tools`; an unknown name gets an "unknown
 * tool" reply. `onOutcome` sees each result, for collecting the data behind it.
 */
export function toolDispatch(
  tools: Tool[],
  ctx: ToolContext,
  onOutcome?: (tool: Tool, outcome: ToolOutcome) => void
): Dispatch {
  const byName = new Map(tools.map((tool) => [tool.spec.name, tool]))
  return async (name, args) => {
    const tool = byName.get(name)
    if (!tool) return 'unknown tool'
    const outcome = await tool.run(args, ctx)
    onOutcome?.(tool, outcome)
    return outcome.text
  }
}
