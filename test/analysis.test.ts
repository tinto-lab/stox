import { beforeEach, describe, expect, it } from 'vitest'
import { data } from './mocks'
import {
  AGGREGATOR_SYSTEM,
  GEO_SEARCH_BUDGET_NOTICE,
  GEOPOLITICS_AGENT_SYSTEM,
  MAX_GEO_SEARCHES,
  MAX_TOOL_ROUNDS,
  formatAnalysisForAgent,
  runStockAnalysis
} from '../src/core/analysis'
import { addConsideration } from '../src/core/considerations'
import type { AssistantMessage, CompletionRequest } from '../src/core/llm'
import { UNKNOWN_ARTICLE_URL_ERROR } from '../src/core/tools'
import { RoutedLLM, article, bar, call, calls, fundamentals, geoArticle, quote, say } from './helpers'

beforeEach(() => {
  for (const fn of Object.values(data)) fn.mockReset()
  data.fetchQuotes.mockResolvedValue({ quotes: [quote()], missing: [] })
  data.fetchBars.mockResolvedValue([bar()])
  data.fetchFundamentals.mockResolvedValue(fundamentals())
  data.fetchNews.mockResolvedValue([article('Story', 'https://e.com/story')])
  data.fetchGeoNews.mockResolvedValue([geoArticle('Curbs', 'https://r.com/curbs')])
  data.fetchArticleText.mockResolvedValue('Full text.')
})

/** Each specialist makes its usual calls, then answers "<agent> analysis". */
function standardLLM(overrides: Record<string, (AssistantMessage | ((r: CompletionRequest) => AssistantMessage))[]> = {}) {
  return new RoutedLLM({
    trend: [calls(call('get_price_history', { ticker: 'AAPL', days: 90 }), call('get_stock_quote', { tickers: ['AAPL'] })), say('trend analysis')],
    fundamentals: [calls(call('get_company_fundamentals', { ticker: 'AAPL' })), say('fundamentals analysis')],
    news: [calls(call('get_stock_news', { tickers: ['AAPL'] })), say('news analysis')],
    geopolitics: [calls(call('get_geopolitical_news', { query: 'chips' })), say('geopolitics analysis')],
    aggregator: [say('Hold, target 230-250.')],
    ...overrides
  })
}

const lastToolResult = (request: CompletionRequest, index = -1): string =>
  (request.messages.filter((m) => m.role === 'tool').at(index) as { content: string }).content

describe('runStockAnalysis', () => {
  it('runs the four specialists, then the aggregator over their write-ups', async () => {
    const llm = standardLLM()
    const result = await runStockAnalysis(llm, 'AAPL')
    expect(result).toEqual({
      ticker: 'AAPL',
      trendText: 'trend analysis',
      fundamentalsText: 'fundamentals analysis',
      newsText: 'news analysis',
      geopoliticsText: 'geopolitics analysis',
      verdictText: 'Hold, target 230-250.',
      quotes: [quote()],
      bars: [bar()],
      articles: [article('Story', 'https://e.com/story')],
      geoArticles: [geoArticle('Curbs', 'https://r.com/curbs')],
      fundamentals: fundamentals()
    })
    const [aggregator] = llm.requestsOf('aggregator')
    expect(aggregator.system).toBe(AGGREGATOR_SYSTEM)
    expect(aggregator.tools).toBeUndefined()
    expect((aggregator.messages[0] as { text: string }).text).toBe(
      'Ticker: AAPL\n\nTrend analysis:\ntrend analysis\n\nFundamentals analysis:\nfundamentals analysis\n\n' +
        'News analysis:\nnews analysis\n\nGeopolitical analysis:\ngeopolitics analysis'
    )
    expect(data.fetchBars).toHaveBeenCalledWith('AAPL', 90)
  })

  it('gives each specialist only its own tools', async () => {
    const llm = standardLLM()
    await runStockAnalysis(llm, 'AAPL')
    const toolsOf = (agent: string) => llm.requestsOf(agent)[0].tools!.map((t) => t.name)
    expect(toolsOf('trend')).toEqual(['get_stock_quote', 'get_price_history'])
    expect(toolsOf('fundamentals')).toEqual(['get_company_fundamentals'])
    expect(toolsOf('news')).toEqual(['get_stock_news', 'read_article'])
    expect(toolsOf('geopolitics')).toEqual(['get_geopolitical_news', 'read_article'])
  })

  it('runs the specialists concurrently, and reports progress per specialist', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const llm = standardLLM()
    const complete = llm.complete.bind(llm)
    llm.complete = async (request) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return complete(request)
    }
    const starts: string[] = []
    const toolCalls: string[] = []
    await runStockAnalysis(llm, 'AAPL', {
      onAgentStart: (name) => starts.push(name),
      onToolCall: (agent, name) => toolCalls.push(`${agent}:${name}`)
    })
    expect(maxInFlight).toBe(4)
    expect(starts).toEqual(['trend', 'fundamentals', 'news', 'geopolitics', 'aggregator'])
    expect(toolCalls.sort()).toEqual([
      'fundamentals:get_company_fundamentals',
      'geopolitics:get_geopolitical_news',
      'news:get_stock_news',
      'trend:get_price_history',
      'trend:get_stock_quote'
    ])
  })

  it('lets the news and geopolitics specialists read only articles their own searches returned', async () => {
    const llm = standardLLM({
      news: [
        calls(call('get_stock_news', { tickers: ['AAPL'] })),
        calls(call('read_article', { url: 'https://e.com/story' }), call('read_article', { url: 'https://r.com/curbs' })),
        say('news analysis')
      ],
      geopolitics: [
        calls(call('get_geopolitical_news', { query: 'chips' })),
        calls(call('read_article', { url: 'https://r.com/curbs' }), call('read_article', { url: 'https://e.com/story' })),
        say('geopolitics analysis')
      ]
    })
    await runStockAnalysis(llm, 'AAPL')
    const [, , newsFinal] = llm.requestsOf('news')
    expect(lastToolResult(newsFinal, -2)).toBe('Full text.')
    expect(lastToolResult(newsFinal, -1)).toBe(UNKNOWN_ARTICLE_URL_ERROR)
    const [, , geoFinal] = llm.requestsOf('geopolitics')
    expect(lastToolResult(geoFinal, -2)).toBe('Full text.')
    expect(lastToolResult(geoFinal, -1)).toBe(UNKNOWN_ARTICLE_URL_ERROR)
  })

  it(`caps the geopolitics specialist at ${MAX_GEO_SEARCHES} searches, even within one round`, async () => {
    const searches = Array.from({ length: MAX_GEO_SEARCHES + 1 }, (_, i) => call('get_geopolitical_news', { query: `q${i}` }))
    const llm = standardLLM({
      geopolitics: [calls(...searches), calls(call('get_geopolitical_news', { query: 'again' })), say('geopolitics analysis')]
    })
    await runStockAnalysis(llm, 'AAPL')
    expect(data.fetchGeoNews).toHaveBeenCalledTimes(MAX_GEO_SEARCHES)
    const [, second, third] = llm.requestsOf('geopolitics')
    expect(lastToolResult(second)).toBe(GEO_SEARCH_BUDGET_NOTICE)
    expect(lastToolResult(third)).toBe(GEO_SEARCH_BUDGET_NOTICE)
    expect(GEOPOLITICS_AGENT_SYSTEM).toContain(`budget of ${MAX_GEO_SEARCHES} searches`)
  })

  it('forces a final answer once a specialist spends its whole round budget on tools', async () => {
    const llm = standardLLM({
      news: [
        ...Array.from({ length: MAX_TOOL_ROUNDS }, () => calls(call('get_stock_news', { tickers: ['AAPL'] }))),
        say('news analysis from what I found')
      ]
    })
    const result = await runStockAnalysis(llm, 'AAPL')
    expect(result.newsText).toBe('news analysis from what I found')
    const final = llm.requestsOf('news').at(-1)!
    expect(final.forbidToolUse).toBe(true)
    expect((final.messages.at(-1) as { text: string }).text).toMatch(/used up your tool-call budget/)
  })

  it('weighs standing considerations in the aggregator', async () => {
    addConsideration('insider selling')
    const llm = standardLLM()
    await runStockAnalysis(llm, 'AAPL')
    expect(llm.requestsOf('aggregator')[0].system).toBe(
      `${AGGREGATOR_SYSTEM}\n\nStanding considerations to weigh:\n- insider selling`
    )
  })

  it('works around a failed specialist instead of failing as a whole', async () => {
    const llm = standardLLM({ news: [] })
    const result = await runStockAnalysis(llm, 'AAPL')
    expect(result.newsText).toBe('Unavailable -- this analysis failed: RoutedLLM: no reply left for news')
    expect(result.articles).toEqual([])
    expect(result.trendText).toBe('trend analysis')
    expect(result.verdictText).toBe('Hold, target 230-250.')
    expect((llm.requestsOf('aggregator')[0].messages[0] as { text: string }).text).toContain(
      'News analysis:\nUnavailable -- this analysis failed'
    )
  })

  it('fails as a whole when every specialist fails', async () => {
    const llm = standardLLM({ trend: [], fundamentals: [], news: [], geopolitics: [] })
    await expect(runStockAnalysis(llm, 'AAPL')).rejects.toThrow(/no reply left for trend/)
    expect(llm.requestsOf('aggregator')).toHaveLength(0)
  })

  it('fails as a whole when the aggregator fails', async () => {
    const llm = standardLLM({ aggregator: [] })
    await expect(runStockAnalysis(llm, 'AAPL')).rejects.toThrow(/no reply left for aggregator/)
  })
})

describe('formatAnalysisForAgent', () => {
  it('has all five sections and lists source urls the way the news tools do', () => {
    const text = formatAnalysisForAgent({
      ticker: 'AAPL',
      trendText: 'T',
      fundamentalsText: 'F',
      newsText: 'N',
      geopoliticsText: 'G',
      verdictText: 'V',
      quotes: [],
      bars: [],
      articles: [article('Story', 'https://e.com/story'), article('No link', '')],
      geoArticles: [geoArticle('Curbs', 'https://r.com/curbs')],
      fundamentals: null
    })
    expect(text).toBe(
      'trend: T\n\nfundamentals: F\n\nnews: N\n\ngeopolitics: G\n\nrisk_assessment: V\n\nsources:\n' +
        'title: Story\nurl: https://e.com/story\ntitle: Curbs\nurl: https://r.com/curbs'
    )
  })
})
