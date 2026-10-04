import { beforeEach, describe, expect, it } from 'vitest'
import { data } from './mocks'
import { ARTICLE_URL } from '../src/core/gnews'
import { MarketDataError } from '../src/core/marketData'
import { FetchError } from '../src/core/webfetch'
import {
  argNumber,
  argStrings,
  runFundamentalsTool,
  runGeoNewsTool,
  runHistoryTool,
  runNewsTool,
  runQuoteTool,
  runReadArticleTool
} from '../src/core/tools'
import { article, bar, fundamentals, geoArticle, quote } from './helpers'

beforeEach(() => {
  for (const fn of Object.values(data)) fn.mockReset()
})

describe('quote tool', () => {
  it('formats found and missing quotes', async () => {
    data.fetchQuotes.mockResolvedValue({ quotes: [quote()], missing: ['NOPE.US'] })
    const [text, quotes] = await runQuoteTool(['AAPL', 'NOPE'])
    expect(text).toBe(
      'AAPL.US: price=227.14 change=+3.04 change_pct=+1.36% open=225.00 high=228.00 low=224.50 prev_close=224.10 volume=50000000\n' +
        'NOPE.US: no data (unknown symbol?)'
    )
    expect(quotes).toEqual([quote()])
  })

  it('surfaces errors as text', async () => {
    data.fetchQuotes.mockRejectedValue(new MarketDataError('access denied'))
    expect(await runQuoteTool(['AAPL'])).toEqual(['error: access denied', []])
    expect(await runQuoteTool([])).toEqual(['error: no tickers given', []])
  })
})

describe('history tool', () => {
  it('summarizes the period instead of listing every bar', async () => {
    data.fetchBars.mockResolvedValue([bar('2026-01-01', 100), { ...bar('2026-01-02', 110), high: 115, low: 99 }])
    const [text, bars] = await runHistoryTool('aapl', 7)
    expect(data.fetchBars).toHaveBeenCalledWith('aapl', 7)
    expect(text).toBe(
      'AAPL.US 2026-01-01..2026-01-02 (2 bars): start=100.00 end=110.00 change=+10.00 change_pct=+10.00% period_high=228.00 period_low=99.00\n' +
        'latest: date=2026-01-02 open=225.00 high=115.00 low=99.00 close=110.00 volume=50000000'
    )
    expect(bars).toHaveLength(2)
  })

  it('reports no data and errors', async () => {
    data.fetchBars.mockResolvedValue([])
    expect(await runHistoryTool('X')).toEqual(['no historical data found', []])
    data.fetchBars.mockRejectedValue(new MarketDataError('boom'))
    expect(await runHistoryTool('X')).toEqual(['error: boom', []])
  })
})

describe('fundamentals tool', () => {
  it('formats metrics, with NA for missing ones', async () => {
    data.fetchFundamentals.mockResolvedValue({ ...fundamentals(), roa: null, pegRatio: null })
    const [text, f] = await runFundamentalsTool('AAPL')
    expect(text).toContain('AAPL.US (Apple Inc.) sector=Technology industry=Consumer Electronics market_cap=4850000000000')
    expect(text).toContain('profit_margin=27.62% operating_margin=32.62% roe=148.75% roa=NA')
    expect(text).toContain('pe_ratio=38.03 forward_pe=31.20 peg_ratio=NA dividend_yield=0.32% analyst_target_price=327.20')
    expect(f?.name).toBe('Apple Inc.')
  })

  it('surfaces errors', async () => {
    data.fetchFundamentals.mockRejectedValue(new MarketDataError('No fundamentals found for ZZZ.'))
    expect(await runFundamentalsTool('ZZZ')).toEqual(['error: No fundamentals found for ZZZ.', null])
  })
})

describe('news tools', () => {
  it('include each article url and full text, falling back to the summary', async () => {
    data.fetchNews.mockResolvedValue([article('One', 'https://e.com/1'), article('Two', 'https://e.com/2')])
    data.fetchArticleText.mockImplementation(async (url: string) => {
      if (url.endsWith('1')) return 'Full article body.'
      throw new FetchError('blocked')
    })
    const [text, articles] = await runNewsTool(['AAPL'])
    expect(text).toBe(
      'date: 2026-01-01\ntitle: One\nurl: https://e.com/1\ntext: Full article body.\n---\n' +
        'date: 2026-01-01\ntitle: Two\nurl: https://e.com/2\ntext: Some summary.'
    )
    expect(articles).toHaveLength(2)
  })

  it('report no results and errors', async () => {
    data.fetchNews.mockResolvedValue([])
    expect(await runNewsTool(['AAPL'])).toEqual(['no recent news found', []])
    data.fetchNews.mockRejectedValue(new MarketDataError('denied'))
    expect(await runNewsTool(['AAPL'])).toEqual(['error: denied', []])
  })

  it('world news: full text, but never fetches an undecoded Google redirect', async () => {
    data.fetchGeoNews.mockResolvedValue([geoArticle('Chips', 'https://r.com/1'), geoArticle('Oil', `${ARTICLE_URL}x`)])
    data.fetchArticleText.mockResolvedValue('Body.')
    const [text] = await runGeoNewsTool('Taiwan chips', 3)
    expect(data.fetchGeoNews).toHaveBeenCalledWith('Taiwan chips', 3)
    expect(data.fetchArticleText).toHaveBeenCalledTimes(1)
    expect(text).toContain('country: TW\nsentiment: negative\ntitle: Chips\nurl: https://r.com/1\ntext: Body.')
    expect(text).toContain(`url: ${ARTICLE_URL}x\ntext: Some summary.`)
  })

  it('world news: no results, errors, empty query', async () => {
    data.fetchGeoNews.mockResolvedValue([])
    expect(await runGeoNewsTool('x')).toEqual(['no relevant world news found', []])
    data.fetchGeoNews.mockRejectedValue(new Error('HTTP 503'))
    expect(await runGeoNewsTool('x')).toEqual(['error: HTTP 503', []])
    expect(await runGeoNewsTool('  ')).toEqual(['error: no query given', []])
  })
})

describe('read_article tool', () => {
  it('returns text or the error', async () => {
    data.fetchArticleText.mockResolvedValue('Body.')
    expect(await runReadArticleTool('https://e.com')).toBe('Body.')
    data.fetchArticleText.mockRejectedValue(new FetchError('server returned HTTP 403'))
    expect(await runReadArticleTool('https://e.com')).toBe('error: server returned HTTP 403')
  })
})

describe('model-supplied arguments', () => {
  it('are coerced defensively', () => {
    expect(argStrings({ t: ['A', 1, ''] }, 't')).toEqual(['A', '1'])
    expect(argStrings({ t: 'A' }, 't')).toEqual(['A'])
    expect(argStrings({}, 't')).toEqual([])
    expect(argNumber({ d: '90' }, 'd', 30)).toBe(90)
    expect(argNumber({ d: 'lots' }, 'd', 30)).toBe(30)
    expect(argNumber({ d: null }, 'd', 30)).toBe(30)
  })
})
