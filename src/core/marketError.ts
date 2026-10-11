/** Raised when a market-data source can't answer (no key, network, rate limit, ...). */
export class MarketDataError extends Error {}

/** Coerce a JSON value to a number, or null -- EODHD uses the string "NA" for missing fields. */
export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
