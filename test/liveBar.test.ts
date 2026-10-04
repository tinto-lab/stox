import { describe, expect, it } from 'vitest'
import { periodChange, quoteDate, withLiveBar } from '../src/shared/liveBar'
import type { Bar, Quote } from '../src/shared/types'

const bar = (date: string, close: number): Bar => ({ date, open: close, high: close + 1, low: close - 1, close, volume: 100 })

const quoteAt = (date: string, price: number, extra: Partial<Quote> = {}): Quote => ({
  code: 'AAPL.US',
  price,
  change: 0,
  percent: 0,
  open: price,
  high: price + 2,
  low: price - 2,
  prevClose: price,
  volume: 500,
  timestamp: Date.parse(`${date}T15:00:00Z`) / 1000,
  ...extra
})

const bars = [bar('2026-09-30', 100), bar('2026-10-01', 101)]

describe('withLiveBar', () => {
  it('replaces the last bar when the quote is from the same day', () => {
    const out = withLiveBar(bars, quoteAt('2026-10-01', 105), '1M')
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ date: '2026-10-01', close: 105 })
  })

  it('appends a bar when the quote is from a later day', () => {
    const out = withLiveBar(bars, quoteAt('2026-10-02', 99), '1M')
    expect(out).toHaveLength(3)
    expect(out[2]).toMatchObject({ date: '2026-10-02', close: 99, volume: 500 })
  })

  it('leaves the bars alone for a stale quote, a missing timestamp, or no quote', () => {
    expect(withLiveBar(bars, quoteAt('2026-09-29', 90), '1M')).toBe(bars)
    expect(withLiveBar(bars, quoteAt('2026-10-02', 90, { timestamp: null }), '1M')).toBe(bars)
    expect(withLiveBar(bars, undefined, '1M')).toBe(bars)
    expect(withLiveBar([], quoteAt('2026-10-02', 90), '1M')).toEqual([])
  })

  it("extends the current week's bar on the weekly 5Y chart", () => {
    const out = withLiveBar(bars, quoteAt('2026-10-03', 110), '5Y')
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ date: '2026-10-01', close: 110, high: 112, low: 100 })
  })
})

describe('quoteDate', () => {
  it("is the UTC date of the quote's last trade, or null without one", () => {
    expect(quoteDate(quoteAt('2026-10-05', 1))).toBe('2026-10-05')
    expect(quoteDate(quoteAt('2026-10-05', 1, { timestamp: null }))).toBeNull()
    expect(quoteDate(undefined)).toBeNull()
  })
})

describe('periodChange', () => {
  it('is the percent move from the first close to the last', () => {
    expect(periodChange([bar('2026-09-01', 200), bar('2026-10-01', 190)])).toBeCloseTo(-5)
    expect(periodChange([bar('2026-10-01', 190)])).toBeNull()
  })
})
