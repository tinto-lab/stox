import { beforeEach, describe, expect, it } from 'vitest'
import { data, market } from './mocks'
import { ARTICLE_URL } from '../src/core/gnews'
import { MarketDataError } from '../src/core/marketData'
import { FetchError } from '../src/core/webfetch'
import {
  DATA_TOOLS,
  UNKNOWN_ARTICLE_URL_ERROR,
  type ToolContext,
  argNumber,
  argStrings,
  runFundamentalsTool,
  runGeoNewsTool,
  runHistoryTool,
  runNewsTool,
  runQuoteTool,
  runReadArticleTool,
  toolDispatch
} from '../src/core/tools'
import { article, bar, fundamentals, geoArticle, quote } from './helpers'

beforeEach(() => {
  for (const fn of Object.values(data)) fn.mockReset()
})

describe('quote tool', () => {
  it('formats found and missing quotes', async () => {
    data.fetchQuotes.mockResolvedValue({ quotes: [quote()], missing: ['NOPE.US'] })
    const [text, quotes] = await runQuoteTool(market, ['AAPL', 'NOPE'])
    expect(text).toBe(
      'AAPL.US: price=227.14 change=+3.04 change_pct=+1.36% open=225.00 high=228.00 low=224.50 prev_close=224.10 volume=50000000\n' +
        'NOPE.US: no data (unknown symbol?)'
    )
    expect(quotes).toEqual([quote()])
  })

  it('surfaces errors as text', async () => {
    data.fetchQuotes.mockRejectedValue(new MarketDataError('access denied'))
    expect(await runQuoteTool(market, ['AAPL'])).toEqual(['error: access denied', []])
    expect(await runQuoteTool(market, [])).toEqual(['error: no tickers given', []])
  })
})

describe('history tool', () => {
  it('summarizes the period instead of listing every bar', async () => {
    data.fetchBars.mockResolvedValue([bar('2026-01-01', 100), { ...bar('2026-01-02', 110), high: 115, low: 99 }])
    const [text, bars] = await runHistoryTool(market, 'aapl', 7)
    expect(data.fetchBars).toHaveBeenCalledWith('aapl', 7)
    expect(text).toBe(
      'AAPL.US 2026-01-01..2026-01-02 (2 bars): start=100.00 end=110.00 change=+10.00 change_pct=+10.00% period_high=228.00 period_low=99.00\n' +
        'latest: date=2026-01-02 open=225.00 high=115.00 low=99.00 close=110.00 volume=50000000'
    )
    expect(bars).toHaveLength(2)
  })

  it('reports no data and errors', async () => {
    data.fetchBars.mockResolvedValue([])
    expect(await runHistoryTool(market, 'X')).toEqual(['no historical data found', []])
    data.fetchBars.mockRejectedValue(new MarketDataError('boom'))
    expect(await runHistoryTool(market, 'X')).toEqual(['error: boom', []])
  })
})

describe('fundamentals tool', () => {
  it('formats metrics, with NA for missing ones', async () => {
    data.fetchFundamentals.mockResolvedValue({ ...fundamentals(), roa: null, pegRatio: null })
    const [text, f] = await runFundamentalsTool(market, 'AAPL')
    expect(text).toContain('AAPL.US (Apple Inc.) sector=Technology industry=Consumer Electronics market_cap=4850000000000')
    expect(text).toContain('profit_margin=27.62% operating_margin=32.62% roe=148.75% roa=NA')
    expect(text).toContain('pe_ratio=38.03 forward_pe=31.20 peg_ratio=NA dividend_yield=0.32% analyst_target_price=327.20')
    expect(f?.name).toBe('Apple Inc.')
  })

  it('surfaces errors', async () => {
    data.fetchFundamentals.mockRejectedValue(new MarketDataError('No fundamentals found for ZZZ.'))
    expect(await runFundamentalsTool(market, 'ZZZ')).toEqual(['error: No fundamentals found for ZZZ.', null])
  })
})

describe('news tools', () => {
  it('include each article url and full text, falling back to the summary', async () => {
    data.fetchNews.mockResolvedValue([article('One', 'https://e.com/1'), article('Two', 'https://e.com/2')])
    data.fetchArticleText.mockImplementation(async (url: string) => {
      if (url.endsWith('1')) return 'Full article body.'
      throw new FetchError('blocked')
    })
    const [text, articles] = await runNewsTool(market, ['AAPL'])
    expect(text).toBe(
      'date: 2026-01-01\ntitle: One\nurl: https://e.com/1\ntext: Full article body.\n---\n' +
        'date: 2026-01-01\ntitle: Two\nurl: https://e.com/2\ntext: Some summary.'
    )
    expect(articles).toHaveLength(2)
  })

  it('report no results and errors', async () => {
    data.fetchNews.mockResolvedValue([])
    expect(await runNewsTool(market, ['AAPL'])).toEqual(['no recent news found', []])
    data.fetchNews.mockRejectedValue(new MarketDataError('denied'))
    expect(await runNewsTool(market, ['AAPL'])).toEqual(['error: denied', []])
  })

  it('world news: full text, but never fetches an undecoded Google redirect', async () => {
    data.fetchGeoNews.mockResolvedValue([geoArticle('Chips', 'https://r.com/1'), geoArticle('Oil', `${ARTICLE_URL}x`)])
    data.fetchArticleText.mockResolvedValue('Body.')
    const [text] = await runGeoNewsTool(market, 'Taiwan chips', 3)
    expect(data.fetchGeoNews).toHaveBeenCalledWith('Taiwan chips', 3)
    expect(data.fetchArticleText).toHaveBeenCalledTimes(1)
    expect(text).toContain('country: TW\nsentiment: negative\ntitle: Chips\nurl: https://r.com/1\ntext: Body.')
    expect(text).toContain(`url: ${ARTICLE_URL}x\ntext: Some summary.`)
  })

  it('world news: no results, errors, empty query', async () => {
    data.fetchGeoNews.mockResolvedValue([])
    expect(await runGeoNewsTool(market, 'x')).toEqual(['no relevant world news found', []])
    data.fetchGeoNews.mockRejectedValue(new Error('HTTP 503'))
    expect(await runGeoNewsTool(market, 'x')).toEqual(['error: HTTP 503', []])
    expect(await runGeoNewsTool(market, '  ')).toEqual(['error: no query given', []])
  })
})

describe('read_article tool', () => {
  it('returns text or the error', async () => {
    data.fetchArticleText.mockResolvedValue('Body.')
    expect(await runReadArticleTool(market, 'https://e.com')).toBe('Body.')
    data.fetchArticleText.mockRejectedValue(new FetchError('server returned HTTP 403'))
    expect(await runReadArticleTool(market, 'https://e.com')).toBe('error: server returned HTTP 403')
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

describe('tool registry', () => {
  const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({ market, knownUrls: new Set(), ...extra })

  it('routes a call to its tool, and answers an unknown name', async () => {
    data.fetchQuotes.mockResolvedValue({ quotes: [quote()], missing: [] })
    const seen: string[] = []
    const dispatch = toolDispatch([DATA_TOOLS.get_stock_quote], ctx(), (tool, outcome) => seen.push(`${tool.produces}:${(outcome.data as unknown[]).length}`))
    expect(await dispatch('get_stock_quote', { tickers: ['AAPL'] })).toContain('AAPL.US: price=227.14')
    expect(await dispatch('get_price_history', { ticker: 'AAPL' })).toBe('unknown tool')
    expect(seen).toEqual(['quotes:1'])
  })

  it("fills in what the model left out from the context's ticker and history window", async () => {
    data.fetchQuotes.mockResolvedValue({ quotes: [quote()], missing: [] })
    data.fetchBars.mockResolvedValue([bar()])
    const dispatch = toolDispatch([DATA_TOOLS.get_stock_quote, DATA_TOOLS.get_price_history], ctx({ ticker: 'MSFT', historyDays: 90 }))
    await dispatch('get_stock_quote', {})
    await dispatch('get_price_history', {})
    expect(data.fetchQuotes).toHaveBeenCalledWith(['MSFT'])
    expect(data.fetchBars).toHaveBeenCalledWith('MSFT', 90)
  })

  it('reads only articles a news tool returned', async () => {
    data.fetchNews.mockResolvedValue([article('Story', 'https://e.com/story')])
    data.fetchArticleText.mockResolvedValue('Full text.')
    const dispatch = toolDispatch([DATA_TOOLS.get_stock_news, DATA_TOOLS.read_article], ctx())
    expect(await dispatch('read_article', { url: 'https://e.com/story' })).toBe(UNKNOWN_ARTICLE_URL_ERROR)
    await dispatch('get_stock_news', { tickers: ['AAPL'] })
    expect(await dispatch('read_article', { url: 'https://e.com/story' })).toBe('Full text.')
  })
})
