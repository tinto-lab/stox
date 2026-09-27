/**
 * Chat-panel result shapes: the `data` of a bridge `result` event, mirroring
 * the __dict__ of stoxlib's plain result objects (see stoxlib/bridge.py's
 * _default serializer). The command/event envelope itself is in
 * src/shared/bridgeProtocol.ts. Separate from src/shared/types.ts on
 * purpose -- these are the Python backend's snake_case shapes, not the
 * market data the dashboard fetches directly.
 */

export type { BridgeCommand, BridgeEvent } from '../../shared/bridgeProtocol'

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
  provider: string
  model: string
  provider_key_present: boolean
}
