import { net } from 'electron'
import { normalize } from '../shared/symbols'
import type { Bar, Fundamentals, HistoryRange, Quote, QuoteResult, SymbolMatch } from '../shared/types'
import { readEnvFile } from './envFile'

/**
 * The app's only data source: calls EODHD (quotes, history, symbol search)
 * and Yahoo Finance (fundamentals) directly from the main process -- the
 * same providers stoxlib/quotes.py, history.py and fundamentals.py use,
 * without going through the Python backend.
 *
 * Requests go through Electron's `net` (Chromium's network stack), not
 * Node's fetch: Yahoo rate-limits Node's TLS fingerprint on sight (HTTP 429
 * on the very first request -- the reason yfinance impersonates Chrome via
 * curl_cffi), and `net` also keeps Yahoo's session cookie in the default
 * session for us.
 */

const EODHD_URL = 'https://eodhd.com/api'
const YAHOO_URL = 'https://query2.finance.yahoo.com'

export class MarketDataError extends Error {}

/** EODHD's 404: an unknown ticker on /eod ("Ticker Not Found."), or a search
 * path it can't route. Callers where "nothing there" is a normal answer
 * catch this and return empty instead. */
class NotFoundError extends MarketDataError {}

/** Read on every call so a key saved from Settings takes effect immediately.
 * An exported env var wins over the file, matching stoxlib/config.py. */
function eodhdKey(): string {
  const key = process.env.EODHD_API_KEY || readEnvFile().EODHD_API_KEY || ''
  if (!key) throw new MarketDataError('No EODHD API key set -- add one in Settings.')
  return key
}

export function hasEodhdKey(): boolean {
  return Boolean(process.env.EODHD_API_KEY || readEnvFile().EODHD_API_KEY)
}

/** Coerce a JSON value to a number, or null -- EODHD uses the string "NA" for missing fields. */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

async function eodhdGet(path: string, params: Record<string, string>, timeoutMs = 10_000): Promise<unknown> {
  const query = new URLSearchParams({ ...params, api_token: eodhdKey(), fmt: 'json' })
  let response: Response
  try {
    response = await net.fetch(`${EODHD_URL}/${path}?${query}`, { signal: AbortSignal.timeout(timeoutMs) })
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

export async function fetchHistory(ticker: string, range: HistoryRange): Promise<Bar[]> {
  const code = normalize(ticker)
  const cacheKey = `${code}:${range}`
  const cached = historyCache.get(cacheKey)
  if (cached && Date.now() - cached.at < HISTORY_TTL_MS) return cached.bars

  const { days, period } = RANGES[range] ?? RANGES['1M']
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  let rows: Record<string, unknown>[]
  try {
    rows = asRows(await eodhdGet(`eod/${encodeURIComponent(code)}`, { from, period }))
  } catch (e) {
    // Unknown ticker: no history, the same as stoxlib/history.py's empty list.
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
  historyCache.set(cacheKey, { at: Date.now(), bars })
  return bars
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

// -- fundamentals (Yahoo) --

// EODHD exchange code -> Yahoo ticker suffix, for the exchanges where the two differ.
const YAHOO_SUFFIX: Record<string, string> = {
  US: '',
  LSE: '.L',
  XETRA: '.DE',
  F: '.F',
  BE: '.BE',
  TSE: '.T',
  KO: '.KS',
  KQ: '.KQ',
  SHG: '.SS',
  SHE: '.SZ',
  AU: '.AX',
  NSE: '.NS',
  BSE: '.BO',
  SA: '.SA',
  MX: '.MX',
  HK: '.HK'
}

export function yahooSymbol(code: string): string {
  const normalized = normalize(code)
  const dot = normalized.lastIndexOf('.')
  const symbol = normalized.slice(0, dot)
  const exchange = normalized.slice(dot + 1)
  if (exchange === 'CC') return symbol // BTC-USD.CC -> BTC-USD
  if (exchange === 'FOREX') return `${symbol}=X` // EURUSD.FOREX -> EURUSD=X
  if (exchange in YAHOO_SUFFIX) return symbol + YAHOO_SUFFIX[exchange]
  return `${symbol}.${exchange}` // most other exchanges (TO, PA, AS, SW, ...) share the suffix
}

let yahooCrumb: string | null = null

/** Yahoo's quoteSummary needs a session cookie plus a matching "crumb" token.
 * fc.yahoo.com sets the cookie (as a 404, which is expected); getcrumb then
 * returns the token for that cookie. Cached until Yahoo rejects it. */
async function getCrumb(refresh: boolean): Promise<string> {
  if (yahooCrumb && !refresh) return yahooCrumb
  await net.fetch('https://fc.yahoo.com', { signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
  const response = await net.fetch(`${YAHOO_URL}/v1/test/getcrumb`, { signal: AbortSignal.timeout(10_000) })
  const crumb = (await response.text()).trim()
  if (!response.ok || !crumb || crumb.includes('<')) {
    throw new MarketDataError(`Couldn't start a Yahoo Finance session (HTTP ${response.status}).`)
  }
  yahooCrumb = crumb
  return crumb
}

const SUMMARY_MODULES = 'price,assetProfile,summaryDetail,financialData,defaultKeyStatistics'

async function fetchQuoteSummary(symbol: string): Promise<Record<string, Record<string, unknown>>> {
  for (const refresh of [false, true]) {
    const crumb = await getCrumb(refresh)
    const url = `${YAHOO_URL}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${SUMMARY_MODULES}&crumb=${encodeURIComponent(crumb)}`
    let response: Response
    try {
      response = await net.fetch(url, { signal: AbortSignal.timeout(15_000) })
    } catch (e) {
      throw new MarketDataError(`Network error: ${(e as Error).message}`)
    }
    if (response.status === 401 && !refresh) continue // stale crumb -- get a fresh one and retry once
    if (response.status === 404) throw new MarketDataError(`No fundamentals found for ${symbol}.`)
    if (response.status === 429) throw new MarketDataError('Yahoo Finance rate limit reached -- try again later.')
    if (!response.ok) throw new MarketDataError(`Yahoo Finance returned HTTP ${response.status}.`)
    const body = (await response.json()) as { quoteSummary?: { result?: Record<string, Record<string, unknown>>[] } }
    const result = body.quoteSummary?.result?.[0]
    if (!result) throw new MarketDataError(`No fundamentals found for ${symbol}.`)
    return result
  }
  throw new MarketDataError('Yahoo Finance rejected the session.')
}

/** Yahoo wraps most numbers as {raw, fmt}; some are bare. */
function raw(value: unknown): number | null {
  if (value && typeof value === 'object' && 'raw' in value) return num((value as { raw: unknown }).raw)
  return num(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

const FUNDAMENTALS_TTL_MS = 60 * 60_000
const fundamentalsCache = new Map<string, { at: number; data: Fundamentals }>()

export async function fetchFundamentals(ticker: string): Promise<Fundamentals> {
  const code = normalize(ticker)
  const cached = fundamentalsCache.get(code)
  if (cached && Date.now() - cached.at < FUNDAMENTALS_TTL_MS) return cached.data

  const symbol = yahooSymbol(code)
  const s = await fetchQuoteSummary(symbol)
  const price = s.price ?? {}
  const profile = s.assetProfile ?? {}
  const detail = s.summaryDetail ?? {}
  const fin = s.financialData ?? {}
  const stats = s.defaultKeyStatistics ?? {}

  const data: Fundamentals = {
    code,
    yahooSymbol: symbol,
    name: str(price.longName) ?? str(price.shortName),
    sector: str(profile.sector),
    industry: str(profile.industry),
    country: str(profile.country),
    website: str(profile.website),
    employees: raw(profile.fullTimeEmployees),
    summary: str(profile.longBusinessSummary),
    currency: str(price.currency) ?? str(fin.financialCurrency),
    marketCap: raw(price.marketCap) ?? raw(detail.marketCap),
    enterpriseValue: raw(stats.enterpriseValue),
    trailingPE: raw(detail.trailingPE),
    forwardPE: raw(detail.forwardPE) ?? raw(stats.forwardPE),
    pegRatio: raw(stats.pegRatio),
    priceToBook: raw(stats.priceToBook),
    priceToSales: raw(detail.priceToSalesTrailing12Months),
    eps: raw(stats.trailingEps),
    forwardEps: raw(stats.forwardEps),
    dividendYield: raw(detail.dividendYield),
    payoutRatio: raw(detail.payoutRatio),
    beta: raw(detail.beta) ?? raw(stats.beta),
    fiftyTwoWeekLow: raw(detail.fiftyTwoWeekLow),
    fiftyTwoWeekHigh: raw(detail.fiftyTwoWeekHigh),
    grossMargin: raw(fin.grossMargins),
    operatingMargin: raw(fin.operatingMargins),
    profitMargin: raw(fin.profitMargins) ?? raw(stats.profitMargins),
    roe: raw(fin.returnOnEquity),
    roa: raw(fin.returnOnAssets),
    revenueTtm: raw(fin.totalRevenue),
    revenueGrowth: raw(fin.revenueGrowth),
    earningsGrowth: raw(fin.earningsGrowth),
    ebitda: raw(fin.ebitda),
    freeCashflow: raw(fin.freeCashflow),
    totalCash: raw(fin.totalCash),
    totalDebt: raw(fin.totalDebt),
    debtToEquity: raw(fin.debtToEquity),
    currentRatio: raw(fin.currentRatio),
    targetMeanPrice: raw(fin.targetMeanPrice),
    recommendation: str(fin.recommendationKey),
    analystCount: raw(fin.numberOfAnalystOpinions)
  }
  fundamentalsCache.set(code, { at: Date.now(), data })
  return data
}
