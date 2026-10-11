import { normalize } from '../shared/symbols'
import type { Article, Bar, HistoryRange, Quote, QuoteResult, SymbolMatch } from '../shared/types'
import { MarketDataError, num } from './marketError'

/**
 * EODHD: quotes, price history, news and symbol search, called directly
 * with fetch. Shared by the app's dashboard, the chat agent's tools and the
 * terminal CLI.
 */

const EODHD_URL = 'https://eodhd.com/api'

/** EODHD's 404: an unknown ticker on /eod ("Ticker Not Found."), or a search
 * path it can't route. Callers where "nothing there" is a normal answer
 * catch this and return empty instead. */
class NotFoundError extends MarketDataError {}

/** Read on every call, so a key loaded or saved after startup takes effect
 * (see config.loadEnv). */
function eodhdKey(): string {
  const key = process.env.EODHD_API_KEY || ''
  if (!key) throw new MarketDataError('No EODHD API key set -- add EODHD_API_KEY in Settings (or ~/.config/stox/.env).')
  return key
}

export function hasEodhdKey(): boolean {
  return Boolean(process.env.EODHD_API_KEY)
}

async function eodhdGet(path: string, params: Record<string, string>, timeoutMs = 10_000): Promise<unknown> {
  const query = new URLSearchParams({ ...params, api_token: eodhdKey(), fmt: 'json' })
  let response: Response
  try {
    response = await fetch(`${EODHD_URL}/${path}?${query}`, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw new MarketDataError(`Network error: ${(e as Error).message}`)
  }
  if (response.status === 401 || response.status === 403) {
    throw new MarketDataError('EODHD denied access -- check your API key and plan.')
  }
  if (response.status === 404) throw new NotFoundError("EODHD doesn't recognize that symbol.")
  if (response.status === 429) throw new MarketDataError('EODHD rate limit reached -- try again later.')
  if (!response.ok) throw new MarketDataError(`EODHD returned HTTP ${response.status}.`)
  try {
    return await response.json()
  } catch {
    throw new MarketDataError("Couldn't parse EODHD's response.")
  }
}

function asRows(data: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(data) ? data : [data]
  return rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
}

// -- quotes --

function parseQuote(row: Record<string, unknown>): Quote | null {
  const price = num(row.close)
  if (price === null) return null // unknown symbol / no data
  return {
    code: String(row.code ?? '?'),
    price,
    change: num(row.change) ?? 0,
    percent: num(row.change_p) ?? 0,
    open: num(row.open) ?? 0,
    high: num(row.high) ?? 0,
    low: num(row.low) ?? 0,
    prevClose: num(row.previousClose) ?? 0,
    volume: num(row.volume) ?? 0,
    timestamp: num(row.timestamp)
  }
}

// EODHD recommends keeping a multi-ticker real-time request to ~15-20 symbols.
const QUOTE_BATCH = 15

export async function fetchQuotes(tickers: string[]): Promise<QuoteResult> {
  const codes = [...new Set(tickers.map(normalize))]
  const batches: string[][] = []
  for (let i = 0; i < codes.length; i += QUOTE_BATCH) batches.push(codes.slice(i, i + QUOTE_BATCH))

  const results = await Promise.all(
    batches.map(async ([first, ...rest]) => {
      const params: Record<string, string> = rest.length ? { s: rest.join(',') } : {}
      return asRows(await eodhdGet(`real-time/${encodeURIComponent(first)}`, params))
    })
  )
  const quotes = results.flat().map(parseQuote).filter((q): q is Quote => q !== null)
  const found = new Set(quotes.map((q) => q.code))
  return { quotes, missing: codes.filter((c) => !found.has(c)) }
}

// -- history --

const RANGES: Record<HistoryRange, { days: number; period: 'd' | 'w' }> = {
  '1M': { days: 31, period: 'd' },
  '3M': { days: 92, period: 'd' },
  '6M': { days: 183, period: 'd' },
  '1Y': { days: 366, period: 'd' },
  '5Y': { days: 5 * 366, period: 'w' }
}

const HISTORY_TTL_MS = 10 * 60_000
const historyCache = new Map<string, { at: number; bars: Bar[] }>()

/** The dashboard's chart: a fixed range, cached for a few minutes. */
export async function fetchHistory(ticker: string, range: HistoryRange): Promise<Bar[]> {
  const code = normalize(ticker)
  const cacheKey = `${code}:${range}`
  const cached = historyCache.get(cacheKey)
  if (cached && Date.now() - cached.at < HISTORY_TTL_MS) return cached.bars

  const { days, period } = RANGES[range] ?? RANGES['1M']
  const bars = await fetchBars(code, days, period)
  historyCache.set(cacheKey, { at: Date.now(), bars })
  return bars
}

/** OHLC bars for the last `days` days, oldest first; an unknown ticker is
 * just an empty list. */
export async function fetchBars(ticker: string, days: number, period: 'd' | 'w' | 'm' = 'd'): Promise<Bar[]> {
  const code = normalize(ticker)
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  let rows: Record<string, unknown>[]
  try {
    rows = asRows(await eodhdGet(`eod/${encodeURIComponent(code)}`, { from, period }))
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e
    rows = []
  }

  const bars: Bar[] = []
  for (const row of rows) {
    // adjusted_close, so a split inside a long range doesn't draw as a crash.
    const close = num(row.adjusted_close) ?? num(row.close)
    if (close === null || typeof row.date !== 'string') continue
    bars.push({
      date: row.date,
      open: num(row.open) ?? close,
      high: num(row.high) ?? close,
      low: num(row.low) ?? close,
      close,
      volume: num(row.volume) ?? 0
    })
  }
  return bars
}

// -- news --

function truncate(text: string, limit = 240): string {
  const flat = text.split(/\s+/).filter(Boolean).join(' ')
  if (flat.length <= limit) return flat
  const cut = flat.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  return (space > 0 ? cut.slice(0, space) : cut) + '…'
}

/** Recent articles mentioning any of `tickers`, newest first. */
export async function fetchNews(tickers: string[], limit = 5): Promise<Article[]> {
  const codes = tickers.map(normalize)
  // EODHD's ticker-filtered news query is slow -- 10-17s observed even for
  // one ticker, vs. under 2s for quotes -- so it gets a longer timeout.
  const rows = asRows(await eodhdGet('news', { s: codes.join(','), limit: String(limit) }, 25_000))
  const articles: Article[] = []
  for (const row of rows) {
    if (typeof row.title !== 'string' || !row.title) continue
    const sentiment = row.sentiment && typeof row.sentiment === 'object' ? (row.sentiment as { polarity?: number }) : {}
    articles.push({
      title: row.title,
      date: typeof row.date === 'string' ? row.date : '',
      link: typeof row.link === 'string' ? row.link : '',
      symbols: Array.isArray(row.symbols) ? row.symbols.map(String) : [],
      sentiment,
      summary: truncate(typeof row.content === 'string' ? row.content : '')
    })
  }
  return articles
}

// -- symbol search --

export async function searchSymbols(query: string): Promise<SymbolMatch[]> {
  // The query is a path segment, and EODHD 404s on a slash in it even when encoded.
  const q = query.replace(/[/\\]+/g, ' ').trim()
  if (!q) return []
  let rows: Record<string, unknown>[]
  try {
    rows = asRows(await eodhdGet(`search/${encodeURIComponent(q)}`, { limit: '10' }))
  } catch (e) {
    if (e instanceof NotFoundError) return []
    throw e
  }
  return rows
    .filter((row) => row.Code && row.Exchange)
    .map((row) => ({
      code: `${String(row.Code).toUpperCase()}.${String(row.Exchange).toUpperCase()}`,
      name: String(row.Name ?? ''),
      exchange: String(row.Exchange),
      type: String(row.Type ?? ''),
      country: String(row.Country ?? ''),
      currency: String(row.Currency ?? '')
    }))
}

