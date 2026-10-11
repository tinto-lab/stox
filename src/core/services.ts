import type { Article, Bar, Fundamentals, GeoArticle, QuoteResult } from '../shared/types'
import { addConsideration, considerationsPath, loadConsiderations, removeConsideration } from './considerations'
import { fetchGeoNews } from './gnews'
import { fetchBars, fetchFundamentals, fetchNews, fetchQuotes } from './marketData'
import { fetchArticleText } from './webfetch'

/**
 * What the agents need from the outside world, as ports: the tools and the
 * analysis depend on these interfaces, not on EODHD, Yahoo, Google News or
 * the filesystem. defaultServices is the one place the real implementations
 * are wired in; tests pass fakes instead.
 */

/** Everything the data tools look up. */
export interface MarketData {
  quotes(tickers: string[]): Promise<QuoteResult>
  /** Daily OHLC bars for the last `days` days, oldest first. */
  bars(ticker: string, days: number): Promise<Bar[]>
  news(tickers: string[], limit: number): Promise<Article[]>
  geoNews(query: string, limit: number): Promise<GeoArticle[]>
  fundamentals(ticker: string): Promise<Fundamentals>
  /** The readable text of one web page. */
  articleText(url: string): Promise<string>
}

/** The user's standing considerations (see considerations.ts). */
export interface ConsiderationStore {
  /** Where they're kept, for messages that point the user at it. */
  readonly location: string
  list(): string[]
  add(text: string): void
  /** Returns what's left. */
  remove(text: string): string[]
}

export interface Services {
  market: MarketData
  considerations: ConsiderationStore
}

export const defaultServices: Services = {
  market: {
    quotes: (tickers) => fetchQuotes(tickers),
    bars: (ticker, days) => fetchBars(ticker, days),
    news: (tickers, limit) => fetchNews(tickers, limit),
    geoNews: (query, limit) => fetchGeoNews(query, limit),
    fundamentals: (ticker) => fetchFundamentals(ticker),
    articleText: (url) => fetchArticleText(url)
  },
  considerations: {
    get location() {
      return considerationsPath()
    },
    list: loadConsiderations,
    add: addConsideration,
    remove: removeConsideration
  }
}
