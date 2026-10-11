import { normalize } from '../shared/symbols'
import type { Fundamentals } from '../shared/types'
import { MarketDataError, num } from './marketError'

/**
 * Yahoo Finance fundamentals, called directly with fetch.
 *
 * Yahoo turns away a request without its session cookie, so getYahooSession()
 * carries that cookie by hand rather than relying on a cookie jar.
 */

const YAHOO_URL = 'https://query2.finance.yahoo.com'

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

let yahooSession: { crumb: string; cookie: string } | null = null

/** Yahoo's quoteSummary needs a session cookie plus a matching "crumb" token.
 * fc.yahoo.com sets the cookie (as a 404, which is expected); getcrumb then
 * returns the token for that cookie. Cached until Yahoo rejects it. */
async function getYahooSession(refresh: boolean): Promise<{ crumb: string; cookie: string }> {
  if (yahooSession && !refresh) return yahooSession
  let cookie = ''
  try {
    const response = await fetch('https://fc.yahoo.com', { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')
  } catch {
    // getcrumb below fails with a clear message if there's no session
  }
  const response = await fetch(`${YAHOO_URL}/v1/test/getcrumb`, {
    headers: { cookie, 'user-agent': YAHOO_USER_AGENT },
    signal: AbortSignal.timeout(10_000)
  })
  const crumb = (await response.text()).trim()
  if (!response.ok || !crumb || crumb.includes('<')) {
    throw new MarketDataError(`Couldn't start a Yahoo Finance session (HTTP ${response.status}).`)
  }
  yahooSession = { crumb, cookie }
  return yahooSession
}

const YAHOO_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)'

const SUMMARY_MODULES = 'price,assetProfile,summaryDetail,financialData,defaultKeyStatistics'

async function fetchQuoteSummary(symbol: string): Promise<Record<string, Record<string, unknown>>> {
  for (const refresh of [false, true]) {
    const { crumb, cookie } = await getYahooSession(refresh)
    const url = `${YAHOO_URL}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${SUMMARY_MODULES}&crumb=${encodeURIComponent(crumb)}`
    let response: Response
    try {
      response = await fetch(url, {
        headers: { cookie, 'user-agent': YAHOO_USER_AGENT },
        signal: AbortSignal.timeout(15_000)
      })
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

