/**
 * Market data: EODHD (quotes, history, news, symbol search) and Yahoo
 * Finance (fundamentals), shared by the app's dashboard, the chat agent's
 * tools and the terminal CLI. The sources live in their own modules; this
 * is the one place the rest of the app imports them from.
 */
export { MarketDataError, num } from './marketError'
export { fetchBars, fetchHistory, fetchNews, fetchQuotes, hasEodhdKey, searchSymbols } from './eodhd'
export { fetchFundamentals, yahooSymbol } from './yahoo'
