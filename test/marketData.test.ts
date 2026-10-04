import { describe, expect, it } from 'vitest'
import { fetchBars, fetchFundamentals, fetchNews, fetchQuotes, num, yahooSymbol } from '../src/core/marketData'
import { normalize } from '../src/shared/symbols'
import { json, stubFetch } from './helpers'

const EODHD = 'https://eodhd.com/api/'

describe('symbols', () => {
  it('normalizes bare symbols to US listings', () => {
    expect(normalize('aapl')).toBe('AAPL.US')
    expect(normalize('bmw.xetra')).toBe('BMW.XETRA')
    expect(normalize('btc-usd.cc')).toBe('BTC-USD.CC')
  })

  it('maps EODHD codes to Yahoo symbols', () => {
    expect(yahooSymbol('AAPL')).toBe('AAPL')
    expect(yahooSymbol('BTC-USD.CC')).toBe('BTC-USD')
    expect(yahooSymbol('EURUSD.FOREX')).toBe('EURUSD=X')
    expect(yahooSymbol('BMW.XETRA')).toBe('BMW.DE')
    expect(yahooSymbol('SHOP.TO')).toBe('SHOP.TO')
  })

  it('coerces numbers, treating "NA" and blanks as missing', () => {
    expect(num('1.5')).toBe(1.5)
    expect(num(2)).toBe(2)
    expect(num('NA')).toBeNull()
    expect(num('')).toBeNull()
    expect(num(null)).toBeNull()
  })
})

describe('quotes', () => {
  it('needs a key', async () => {
    await expect(fetchQuotes(['AAPL'])).rejects.toThrow(/No EODHD API key/)
  })

  it('parses found quotes and reports missing codes', async () => {
    process.env.EODHD_API_KEY = 'k'
    const fetch = stubFetch({
      [EODHD]: () =>
        json([
          { code: 'AAPL.US', close: 227.14, change: 3.04, change_p: 1.36, previousClose: 224.1, volume: 5e7 },
          { code: 'NOPE.US', close: 'NA' }
        ])
    })
    const { quotes, missing } = await fetchQuotes(['aapl', 'nope'])
    expect(quotes).toHaveLength(1)
    expect(quotes[0]).toMatchObject({ code: 'AAPL.US', price: 227.14, change: 3.04, percent: 1.36, prevClose: 224.1, open: 0 })
    expect(missing).toEqual(['NOPE.US'])
    const url = new URL(fetch.mock.calls[0][0] as string)
    expect(url.pathname).toBe('/api/real-time/AAPL.US')
    expect(url.searchParams.get('s')).toBe('NOPE.US')
    expect(url.searchParams.get('api_token')).toBe('k')
  })

  it('accepts a single-object response', async () => {
    process.env.EODHD_API_KEY = 'k'
    stubFetch({ [EODHD]: () => json({ code: 'AAPL.US', close: 1 }) })
    expect((await fetchQuotes(['AAPL'])).quotes).toHaveLength(1)
  })

  it.each([
    [401, /denied access/],
    [403, /denied access/],
    [429, /rate limit/],
    [500, /HTTP 500/]
  ])('reports HTTP %i', async (status, message) => {
    process.env.EODHD_API_KEY = 'k'
    stubFetch({ [EODHD]: () => new Response('', { status }) })
    await expect(fetchQuotes(['AAPL'])).rejects.toThrow(message)
  })

  it('reports bad JSON and network errors', async () => {
    process.env.EODHD_API_KEY = 'k'
    stubFetch({ [EODHD]: () => new Response('<html>') })
    await expect(fetchQuotes(['AAPL'])).rejects.toThrow(/parse/)
    stubFetch({
      [EODHD]: () => {
        throw new TypeError('connection refused')
      }
    })
    await expect(fetchQuotes(['AAPL'])).rejects.toThrow(/Network error: connection refused/)
  })
})

describe('history', () => {
  it('parses bars oldest first, preferring adjusted close and skipping bad rows', async () => {
    process.env.EODHD_API_KEY = 'k'
    const fetch = stubFetch({
      [EODHD]: () =>
        json([
          { date: '2026-01-01', open: 1, high: 2, low: 0.5, close: 1.5, adjusted_close: 1.4, volume: 10 },
          { date: '2026-01-02', close: 'NA' },
          { close: 3 },
          { date: '2026-01-03', close: 2 }
        ])
    })
    const bars = await fetchBars('AAPL', 30, 'w')
    expect(bars).toEqual([
      { date: '2026-01-01', open: 1, high: 2, low: 0.5, close: 1.4, volume: 10 },
      { date: '2026-01-03', open: 2, high: 2, low: 2, close: 2, volume: 0 }
    ])
    const url = new URL(fetch.mock.calls[0][0] as string)
    expect(url.pathname).toBe('/api/eod/AAPL.US')
    expect(url.searchParams.get('period')).toBe('w')
  })

  it('an unknown ticker (404) is no history, not an error', async () => {
    process.env.EODHD_API_KEY = 'k'
    stubFetch({ [EODHD]: () => new Response('Ticker Not Found.', { status: 404 }) })
    expect(await fetchBars('NOPE', 30)).toEqual([])
  })
})

describe('news', () => {
  it('parses articles, skipping untitled ones, with a word-boundary summary', async () => {
    process.env.EODHD_API_KEY = 'k'
    const long = 'word '.repeat(100)
    const fetch = stubFetch({
      [EODHD]: () =>
        json([
          {
            title: 'Apple hits new high',
            date: '2026-01-01T12:00:00+00:00',
            link: 'https://example.com/a',
            symbols: ['AAPL.US'],
            sentiment: { polarity: 0.9 },
            content: `  lots   of\n\nspace ${long}`
          },
          { title: '' },
          { title: 'bare' }
        ])
    })
    const articles = await fetchNews(['aapl', 'msft'], 3)
    expect(articles).toHaveLength(2)
    expect(articles[0]).toMatchObject({ title: 'Apple hits new high', symbols: ['AAPL.US'], sentiment: { polarity: 0.9 } })
    expect(articles[0].summary.startsWith('lots of space word')).toBe(true)
    expect(articles[0].summary.endsWith('word…')).toBe(true)
    expect(articles[0].summary.length).toBeLessThanOrEqual(241)
    expect(articles[1]).toEqual({ title: 'bare', date: '', link: '', symbols: [], sentiment: {}, summary: '' })
    const url = new URL(fetch.mock.calls[0][0] as string)
    expect(url.searchParams.get('s')).toBe('AAPL.US,MSFT.US')
    expect(url.searchParams.get('limit')).toBe('3')
  })
})

describe('fundamentals', () => {
  function stubYahoo(summary: Record<string, unknown>, status = 200) {
    return stubFetch({
      'https://fc.yahoo.com': () =>
        new Response('', { status: 404, headers: { 'set-cookie': 'A3=session; Domain=.yahoo.com; Path=/' } }),
      'https://query2.finance.yahoo.com/v1/test/getcrumb': () => new Response('crumb123'),
      'https://query2.finance.yahoo.com/v10/finance/quoteSummary/': () =>
        status === 200 ? json({ quoteSummary: { result: [summary] } }) : new Response('', { status })
    })
  }

  it('reads Yahoo quoteSummary through the session cookie and crumb', async () => {
    const fetch = stubYahoo({
      price: { longName: 'Apple Inc.', marketCap: { raw: 4.85e12, fmt: '4.85T' }, currency: 'USD' },
      assetProfile: { sector: 'Technology', industry: 'Consumer Electronics' },
      summaryDetail: { trailingPE: { raw: 38.03 }, dividendYield: { raw: 0.0032 } },
      financialData: { profitMargins: { raw: 0.2762 }, targetMeanPrice: { raw: 327.2 } },
      defaultKeyStatistics: { pegRatio: { raw: 2.66 }, trailingEps: { raw: 8.74 } }
    })
    const f = await fetchFundamentals('AAPL')
    expect(f).toMatchObject({
      code: 'AAPL.US',
      yahooSymbol: 'AAPL',
      name: 'Apple Inc.',
      sector: 'Technology',
      marketCap: 4.85e12,
      trailingPE: 38.03,
      pegRatio: 2.66,
      eps: 8.74,
      dividendYield: 0.0032,
      profitMargin: 0.2762,
      targetMeanPrice: 327.2,
      roe: null
    })
    const summaryCall = fetch.mock.calls.find(([u]) => String(u).includes('quoteSummary'))!
    expect(String(summaryCall[0])).toContain('crumb=crumb123')
    expect((summaryCall[1]!.headers as Record<string, string>).cookie).toBe('A3=session')
  })

  it('reports an unknown symbol', async () => {
    stubYahoo({}, 404)
    await expect(fetchFundamentals('ZZZZQ')).rejects.toThrow(/No fundamentals found for ZZZZQ/)
  })
})
