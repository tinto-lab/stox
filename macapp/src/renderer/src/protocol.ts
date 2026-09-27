/**
 * Renderer-side copy of the wire protocol (see stoxlib/bridge.py and
 * macapp/src/main/protocol.ts) -- main/preload/renderer are three separate
 * TS build roots in this project, so this is kept in sync by hand rather
 * than shared via a cross-root import.
 */

export type BridgeCommand =
  | { id: string; cmd: 'ask'; text: string }
  | { id: string; cmd: 'quote'; tickers: string[] }
  | { id: string; cmd: 'analyze'; ticker: string }
  | { id: string; cmd: 'reset' }
  | { id: string; cmd: 'considerations_list' }
  | { id: string; cmd: 'considerations_add'; text: string }
  | { id: string; cmd: 'considerations_remove'; text: string }
  | { id: string; cmd: 'status' }

interface BridgeEventBase {
  id: string | null
}

export interface ToolCallEvent extends BridgeEventBase {
  type: 'tool_call'
  name: string
  args: Record<string, unknown>
}

export interface SpecialistStartEvent extends BridgeEventBase {
  type: 'specialist_start'
  name: string
}

export interface SpecialistToolCallEvent extends BridgeEventBase {
  type: 'specialist_tool_call'
  agent: string
  name: string
  args: Record<string, unknown>
}

export interface ResultEvent extends BridgeEventBase {
  type: 'result'
  data: unknown
}

export interface ErrorEvent extends BridgeEventBase {
  type: 'error'
  message: string
}

export type BridgeEvent =
  | ToolCallEvent
  | SpecialistStartEvent
  | SpecialistToolCallEvent
  | ResultEvent
  | ErrorEvent

// -- result.data shapes, mirroring the __dict__ of stoxlib's plain result
// objects (see stoxlib/bridge.py's _default serializer) --

export interface Quote {
  code: string
  price: number
  change: number
  percent: number
  open: number
  high: number
  low: number
  prev_close: number
  volume: number
}

export interface Bar {
  code: string
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface Fundamentals {
  code: string
  name: string | null
  sector: string | null
  industry: string | null
  market_cap: number | null
  pe_ratio: number | null
  peg_ratio: number | null
  profit_margin: number | null
  operating_margin: number | null
  roe: number | null
  roa: number | null
  ebitda: number | null
  revenue_ttm: number | null
  revenue_growth_yoy: number | null
  earnings_growth_yoy: number | null
  eps: number | null
  dividend_yield: number | null
  analyst_target_price: number | null
}

export interface Article {
  title: string
  date: string
  link: string
  symbols: string[]
  sentiment: { polarity?: number }
  summary: string
}

export interface GeoArticle {
  title: string
  date: string
  link: string
  country: string
  sentiment: string
  summary: string
}

export interface AnalysisResult {
  ticker: string
  trend_text: string
  fundamentals_text: string
  news_text: string
  geopolitics_text: string
  verdict_text: string
  quotes: Quote[]
  bars: Bar[]
  articles: Article[]
  geo_articles: GeoArticle[]
  fundamentals: Fundamentals | null
  error: string | null
}

export interface AgentResultData {
  text: string
  quotes: Quote[]
  articles: Article[]
  geo_articles: GeoArticle[]
  bars: Bar[]
  fundamentals: Fundamentals | null
  analysis: AnalysisResult | null
  error: string | null
}

export interface QuoteResultData {
  quotes: Quote[]
  missing: string[]
}

export interface ConsiderationsData {
  considerations: string[]
}

export interface StatusData {
  eodhd_key: boolean
  webz_key: boolean
  provider: string
  model: string
  provider_key_present: boolean
}
