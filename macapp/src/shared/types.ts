/**
 * Data shapes shared by the core (src/core/, which calls the market data and
 * LLM APIs), the main process, the terminal CLI and the renderer. Included
 * by both the node and web tsconfigs, so there's one copy instead of a
 * hand-synced pair.
 *
 * Tickers are EODHD codes throughout (`AAPL.US`, `SHOP.TO`, `BTC-USD.CC`):
 * quotes and history come from EODHD, so its symbology is the canonical one,
 * and the Yahoo symbol needed for fundamentals is derived from it.
 */

import type { BridgeCommand, BridgeEvent } from './bridgeProtocol'

export interface Quote {
  code: string
  price: number
  change: number
  percent: number
  open: number
  high: number
  low: number
  prevClose: number
  volume: number
  /** Unix seconds of the last trade, or null when EODHD doesn't say. */
  timestamp: number | null
}

export interface QuoteResult {
  quotes: Quote[]
  missing: string[]
}

export interface Bar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type HistoryRange = '1M' | '3M' | '6M' | '1Y' | '5Y'

export interface Fundamentals {
  code: string
  yahooSymbol: string
  name: string | null
  sector: string | null
  industry: string | null
  country: string | null
  website: string | null
  employees: number | null
  summary: string | null
  currency: string | null
  marketCap: number | null
  enterpriseValue: number | null
  trailingPE: number | null
  forwardPE: number | null
  pegRatio: number | null
  priceToBook: number | null
  priceToSales: number | null
  eps: number | null
  forwardEps: number | null
  dividendYield: number | null
  payoutRatio: number | null
  beta: number | null
  fiftyTwoWeekLow: number | null
  fiftyTwoWeekHigh: number | null
  grossMargin: number | null
  operatingMargin: number | null
  profitMargin: number | null
  roe: number | null
  roa: number | null
  revenueTtm: number | null
  revenueGrowth: number | null
  earningsGrowth: number | null
  ebitda: number | null
  freeCashflow: number | null
  totalCash: number | null
  totalDebt: number | null
  debtToEquity: number | null
  currentRatio: number | null
  targetMeanPrice: number | null
  recommendation: string | null
  analystCount: number | null
}

export interface SymbolMatch {
  code: string
  name: string
  exchange: string
  type: string
  country: string
  currency: string
}

export interface WatchlistEntry {
  code: string
  name: string
}

export interface MarketStatus {
  hasEodhdKey: boolean
}

/** A company news article, from EODHD's ticker-filtered news feed. */
export interface Article {
  title: string
  date: string
  link: string
  symbols: string[]
  /** EODHD's sentiment scores; `polarity` runs -1..1. */
  sentiment: { polarity?: number }
  summary: string
}

/** A world/geopolitical news article, from a Google News search. The feed
 * carries no country or sentiment, so those stay empty for now. */
export interface GeoArticle {
  title: string
  date: string
  link: string
  country: string
  sentiment: string
  summary: string
}

/** The /analyze pipeline's output: four specialist write-ups, the
 * aggregator's verdict, and the data the specialists fetched. */
export interface AnalysisResult {
  ticker: string
  trendText: string
  fundamentalsText: string
  newsText: string
  geopoliticsText: string
  verdictText: string
  quotes: Quote[]
  bars: Bar[]
  articles: Article[]
  geoArticles: GeoArticle[]
  fundamentals: Fundamentals | null
}

/** One chat answer: the model's text plus whatever data its tools fetched. */
export interface AgentResult {
  text: string
  quotes: Quote[]
  articles: Article[]
  geoArticles: GeoArticle[]
  bars: Bar[]
  fundamentals: Fundamentals | null
  analysis: AnalysisResult | null
}

/** The chat's configuration, for the panel's setup hint. */
export interface ChatStatus {
  eodhdKey: boolean
  provider: string
  model: string
  providerKeyPresent: boolean
}

/** A news monitor, as stored in ~/.config/stox/monitors.json. */
export interface NewsMonitor {
  id: string
  goal: string
  queries: string[]
  tickers: string[]
  created_at: number
}

export type AlertDirection = 'rise' | 'drop' | 'watch'

/** One alert the news watcher raised, from ~/.config/stox/alerts.jsonl. */
export interface NewsAlert {
  id: string
  monitor_id: string
  goal: string
  direction: AlertDirection
  impacts: { ticker: string; direction: AlertDirection }[]
  title: string
  reason: string
  articles: { title: string; link: string; date: string }[]
  created_at: number
  delivered: boolean
  delivery_error?: string
}

export interface MonitorsState {
  monitors: NewsMonitor[]
  /** Newest first. */
  alerts: NewsAlert[]
  /** Whether the monitor loop is running (it only runs while a monitor exists). */
  running: boolean
  /** Unix seconds of the last completed check, this app session. */
  lastCheckAt: number | null
  lastError: string | null
  whatsappConfigured: boolean
}

/** What every IPC handler returns, so a failure reaches the renderer as a
 * plain message instead of Electron's "Error invoking remote method ..." wrapper. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export const THEMES = ['system', 'light', 'dark'] as const
/** The app's appearance: follow macOS, or force light/dark. */
export type Theme = (typeof THEMES)[number]

/** The `window.stox` API the preload script exposes to the renderer. */
export interface StoxApi {
  // Market data -- fetched directly from EODHD/Yahoo by the main process.
  quotes(tickers: string[]): Promise<QuoteResult>
  history(ticker: string, range: HistoryRange): Promise<Bar[]>
  fundamentals(ticker: string): Promise<Fundamentals>
  search(query: string): Promise<SymbolMatch[]>
  status(): Promise<MarketStatus>
  readWatchlist(): Promise<WatchlistEntry[]>
  writeWatchlist(entries: WatchlistEntry[]): Promise<void>
  // Chat panel -- a ChatSession (src/core/session.ts) in the main process.
  send(command: BridgeCommand): void
  onEvent(listener: (event: BridgeEvent) => void): () => void
  readSettings(): Promise<Record<string, string>>
  saveSettings(values: Record<string, string>): Promise<void>
  getTheme(): Promise<Theme>
  setTheme(theme: Theme): Promise<void>
  // News monitors -- read from disk by the main process, which also runs the monitor loop.
  readMonitors(): Promise<MonitorsState>
  removeMonitor(id: string): Promise<void>
  /** Sends a WhatsApp test message with the saved settings; rejects with the reason. */
  sendTestAlert(): Promise<void>
  /** Called whenever monitors, alerts or the monitor's status change. */
  onMonitorsChanged(listener: () => void): () => void
}
