import type { Bar, HistoryRange, Quote } from './types'

/** The trading day of the quote's last trade (YYYY-MM-DD), or null when it
 * has no timestamp. UTC: trading hours fall within one UTC day for the
 * markets we quote. */
export function quoteDate(quote: Quote | undefined): string | null {
  return quote?.timestamp ? new Date(quote.timestamp * 1000).toISOString().slice(0, 10) : null
}

/** EODHD's end-of-day history has no bar for today until after the close, so
 * the live quote is drawn in as the latest bar -- that's what lets Refresh (and
 * the minute timer) move the chart. On the weekly 5Y chart it extends the
 * current week's bar instead of adding a point. */
export function withLiveBar(bars: Bar[], quote: Quote | undefined, range: HistoryRange): Bar[] {
  const date = quoteDate(quote)
  if (!quote || !date || bars.length === 0) return bars
  const last = bars[bars.length - 1]
  if (date < last.date) return bars

  const today: Bar = {
    date,
    open: quote.open,
    high: quote.high,
    low: quote.low,
    close: quote.price,
    volume: quote.volume
  }
  if (date === last.date) return [...bars.slice(0, -1), today]
  if (range === '5Y' && Date.parse(date) - Date.parse(last.date) < 7 * 86_400_000) {
    const week = { ...last, close: quote.price, high: Math.max(last.high, quote.high), low: Math.min(last.low, quote.low) }
    return [...bars.slice(0, -1), week]
  }
  return [...bars, today]
}
