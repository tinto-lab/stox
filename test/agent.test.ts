import { beforeEach, describe, expect, it } from 'vitest'
import { data, market } from './mocks'
import { AGENT_SYSTEM, MAX_AGENT_ROUNDS, MAX_HISTORY_TURNS, askAgent, formatViewContexts, recordAnalysis, trimHistory } from '../src/core/agent'
import { formatAnalysisForAgent } from '../src/core/analysis'
import { addConsideration, loadConsiderations } from '../src/core/considerations'
import type { ChatMessage, ToolCall } from '../src/core/llm'
import type { Services } from '../src/core/services'
import { UNKNOWN_ARTICLE_URL_ERROR } from '../src/core/tools'
import type { AnalysisResult, ViewContext } from '../src/shared/types'
import { FakeLLM, RoutedLLM, article, bar, call, calls, fundamentals, geoArticle, quote, say } from './helpers'

beforeEach(() => {
  for (const fn of Object.values(data)) fn.mockReset()
  data.fetchArticleText.mockRejectedValue(new Error('not in this test'))
})

/** The content of the tool result answering `toolCall`, as the model saw it next. */
function resultFor(llm: FakeLLM, toolCall: ToolCall): string {
  for (const request of llm.requests) {
    const m = request.messages.find((m) => m.role === 'tool' && m.toolCallId === toolCall.id)
    if (m && m.role === 'tool') return m.content
  }
  throw new Error(`no result for ${toolCall.name}`)
}

const analysis = (over: Partial<AnalysisResult> = {}): AnalysisResult => ({
  ticker: 'AAPL.US',
  trendText: 'up',
  fundamentalsText: 'rich',
  newsText: 'calm',
  geopoliticsText: 'tariffs',
  verdictText: 'Hold',
  quotes: [quote()],
  bars: [bar()],
  articles: [article('Tariff story', 'https://e.com/tariff')],
  geoArticles: [],
  fundamentals: fundamentals(),
  ...over
})

describe('askAgent', () => {
  it('answers directly when no tool is needed', async () => {
    const llm = new FakeLLM([say('Hello!')])
    const result = await askAgent(llm, 'hi')
    expect(result).toEqual({
      text: 'Hello!',
      quotes: [],
      articles: [],
      geoArticles: [],
      bars: [],
      fundamentals: null,
      analysis: null
    })
    expect(llm.requests[0].system).toBe(AGENT_SYSTEM)
    expect(llm.requests[0].tools!.map((t) => t.name)).toEqual([
      'get_stock_quote',
      'get_stock_news',
      'get_geopolitical_news',
      'get_price_history',
      'get_company_fundamentals',
      'analyze_stock',
      'read_article',
      'remember_consideration'
    ])
  })

  it('runs the data tools, announcing each, and returns what they fetched', async () => {
    data.fetchQuotes.mockResolvedValue({ quotes: [quote()], missing: [] })
    data.fetchNews.mockResolvedValue([article()])
    data.fetchGeoNews.mockResolvedValue([geoArticle()])
    data.fetchBars.mockResolvedValue([bar()])
    data.fetchFundamentals.mockResolvedValue(fundamentals())
    const turn = [
      call('get_stock_quote', { tickers: ['AAPL'] }),
      call('get_stock_news', { tickers: ['AAPL'], limit: 3 }),
      call('get_geopolitical_news', { query: 'chips' }),
      call('get_price_history', { ticker: 'AAPL', days: 7 }),
      call('get_company_fundamentals', { ticker: 'AAPL' })
    ]
    const llm = new FakeLLM([calls(...turn), say('Here you go.')])
    const announced: string[] = []
    const result = await askAgent(llm, 'everything on apple', [], { onToolCall: (name) => announced.push(name) })

    expect(announced).toEqual(turn.map((c) => c.name))
    expect(result).toMatchObject({
      text: 'Here you go.',
      quotes: [],
      articles: [],
      geoArticles: [],
      bars: [],
      fundamentals: null
    })
    expect(data.fetchNews).toHaveBeenCalledWith(['AAPL'], 3)
    expect(data.fetchBars).toHaveBeenCalledWith('AAPL', 7)
    expect(resultFor(llm, turn[0])).toContain('AAPL.US: price=227.14')
  })

  it('runs analyze_stock with the progress callbacks and folds its data in', async () => {
    data.fetchQuotes.mockResolvedValue({ quotes: [quote('NVDA.US')], missing: [] })
    data.fetchBars.mockResolvedValue([bar()])
    data.fetchFundamentals.mockResolvedValue(fundamentals('NVDA.US'))
    data.fetchNews.mockResolvedValue([article()])
    data.fetchGeoNews.mockResolvedValue([geoArticle()])
    const analyze = call('analyze_stock', { ticker: 'NVDA' })
    // main agent, then 4 specialists (one tool round each + answer), aggregator, main agent again
    const specialist = (name: string, args: Record<string, unknown>) => [calls(call(name, args)), say(`${name} done`)]
    const scripted = new RoutedLLM({
      main: [calls(analyze), say('It is a Buy.')],
      trend: specialist('get_price_history', { ticker: 'NVDA' }),
      fundamentals: specialist('get_company_fundamentals', { ticker: 'NVDA' }),
      news: specialist('get_stock_news', { tickers: ['NVDA'] }),
      geopolitics: specialist('get_geopolitical_news', { query: 'chips' }),
      aggregator: [say('Buy.')]
    })
    const starts: string[] = []
    const specialistCalls: string[] = []
    const result = await askAgent(scripted, 'should I buy nvidia?', [], {
      onAnalysisAgentStart: (name) => starts.push(name),
      onAnalysisToolCall: (agent, name) => specialistCalls.push(`${agent}:${name}`)
    })

    expect(result.text).toBe('It is a Buy.')
    expect(starts).toEqual(['trend', 'fundamentals', 'news', 'geopolitics', 'aggregator'])
    expect(specialistCalls.sort()).toEqual([
      'fundamentals:get_company_fundamentals',
      'geopolitics:get_geopolitical_news',
      'news:get_stock_news',
      'trend:get_price_history'
    ])
    expect(result.analysis).toMatchObject({ ticker: 'NVDA', trendText: 'get_price_history done', verdictText: 'Buy.' })
    const toolResult = scripted.requestsOf('main').at(-1)!.messages.find((m) => m.role === 'tool') as { content: string }
    expect(toolResult.content).toContain('risk_assessment: Buy.')
  })

  it('reads an article only if a news tool returned its url (this turn or earlier)', async () => {
    data.fetchNews.mockResolvedValue([article('One', 'https://e.com/1')])
    data.fetchArticleText.mockResolvedValue('Full text.')
    const news = call('get_stock_news', { tickers: ['AAPL'] })
    const known = call('read_article', { url: 'https://e.com/1' })
    const unknown = call('read_article', { url: 'https://evil.example/x' })
    const llm = new FakeLLM([calls(news), calls(known, unknown), say('Summary.')])
    const history: ChatMessage[] = []
    await askAgent(llm, 'news?', history)
    expect(resultFor(llm, known)).toBe('Full text.')
    expect(resultFor(llm, unknown)).toBe(UNKNOWN_ARTICLE_URL_ERROR)
    // once for the news result's full text, once for read_article -- never the unknown url
    expect(data.fetchArticleText.mock.calls.map(([url]) => url)).toEqual(['https://e.com/1', 'https://e.com/1'])

    // A later turn can still read the url, from history alone.
    const again = call('read_article', { url: 'https://e.com/1' })
    const llm2 = new FakeLLM([calls(again), say('ok')])
    await askAgent(llm2, 'read that first one', history)
    expect(resultFor(llm2, again)).toBe('Full text.')
  })

  it('remembers considerations, which then join the system prompt', async () => {
    const remember = call('remember_consideration', { text: ' insider selling ' })
    const blank = call('remember_consideration', { text: '  ' })
    const llm = new FakeLLM([calls(remember, blank), say('Noted.'), say('ok')])
    await askAgent(llm, 'always consider insider selling')
    expect(resultFor(llm, remember)).toBe('remembered: insider selling')
    expect(resultFor(llm, blank)).toBe('error: nothing to remember')
    expect(loadConsiderations()).toEqual(['insider selling'])

    addConsideration('tariffs')
    await askAgent(llm, 'next')
    expect(llm.requests[2].system).toContain('Standing considerations')
    expect(llm.requests[2].system).toContain('- insider selling\n- tariffs')
  })

  it('reports an unknown tool to the model instead of crashing', async () => {
    const bogus = call('launch_rockets')
    const llm = new FakeLLM([calls(bogus), say('Sorry.')])
    expect((await askAgent(llm, 'q')).text).toBe('Sorry.')
    expect(resultFor(llm, bogus)).toBe('unknown tool')
  })

  it(`forces an answer after ${MAX_AGENT_ROUNDS} rounds of tool calls`, async () => {
    data.fetchQuotes.mockResolvedValue({ quotes: [quote()], missing: [] })
    const llm = new FakeLLM([
      ...Array.from({ length: MAX_AGENT_ROUNDS }, () => calls(call('get_stock_quote', { tickers: ['AAPL'] }))),
      say('AAPL is at 230.')
    ])
    const result = await askAgent(llm, 'price?')
    expect(result.text).toBe('AAPL is at 230.')
    expect(llm.requests).toHaveLength(MAX_AGENT_ROUNDS + 1)
    const final = llm.requests.at(-1)!
    expect(final.forbidToolUse).toBe(true)
    expect((final.messages.at(-1) as { text: string }).text).toMatch(/used up your tool-call budget/)
  })

  it('sends prior history and appends this turn to it in place', async () => {
    const history: ChatMessage[] = [
      { role: 'user', text: 'earlier' },
      { role: 'assistant', text: 'earlier answer', toolCalls: [] }
    ]
    const llm = new FakeLLM([say('now')])
    await askAgent(llm, 'follow-up', history)
    expect(llm.requests[0].messages.map((m) => (m as { text: string }).text)).toEqual([
      'earlier',
      'earlier answer',
      'follow-up'
    ])
    expect(history).toHaveLength(4)
    expect(history.at(-1)).toMatchObject({ role: 'assistant', text: 'now' })
  })

  it('appends the data behind chart-point references to the question', async () => {
    const context: ViewContext = {
      token: '[AAPL on 2026-09-12]',
      code: 'AAPL.US',
      range: '3M',
      bar: { date: '2026-09-12', open: 230, high: 233, low: 229, close: 231, volume: 5000 },
      prevClose: 220,
      rangeStartClose: 200
    }
    const llm = new FakeLLM([say('ok')])
    await askAgent(llm, 'why the jump? [AAPL on 2026-09-12]', [], { contexts: [context] })
    const sent = (llm.requests[0].messages.at(-1) as { text: string }).text
    expect(sent).toMatch(/^why the jump\? \[AAPL on 2026-09-12\]\n\n\[AAPL on 2026-09-12\] = AAPL\.US daily bar 2026-09-12: /)
    expect(sent).toContain('close 231')
    expect(sent).toContain('+5.00% vs previous close')
    expect(sent).toContain('+15.50% since the start of the 3M chart')
  })

  it('leaves the question alone without references', async () => {
    const llm = new FakeLLM([say('ok')])
    await askAgent(llm, 'plain', [], { contexts: [] })
    expect((llm.requests[0].messages.at(-1) as { text: string }).text).toBe('plain')
  })

  it('skips the previous-close change on the first bar', () => {
    const text = formatViewContexts([
      { token: '[X on d]', code: 'X.US', range: '1M', bar: bar(), prevClose: null, rangeStartClose: bar().close }
    ])
    expect(text).not.toContain('previous close')
  })

  it('leaves history untouched when the model fails', async () => {
    const history: ChatMessage[] = [{ role: 'user', text: 'earlier' }]
    const llm = new FakeLLM([])
    await expect(askAgent(llm, 'q', history)).rejects.toThrow(/ran out/)
    expect(history).toEqual([{ role: 'user', text: 'earlier' }])
  })
})

describe('history', () => {
  it('records an /analyze run as a tool-call turn the agent can build on', () => {
    const history: ChatMessage[] = []
    recordAnalysis(history, 'AAPL.US', analysis())
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(history[0]).toEqual({ role: 'user', text: '/analyze AAPL.US' })
    expect((history[1] as { toolCalls: ToolCall[] }).toolCalls[0]).toMatchObject({
      name: 'analyze_stock',
      args: { ticker: 'AAPL.US' }
    })
    expect((history[2] as { content: string }).content).toBe(formatAnalysisForAgent(analysis()))
  })

  it('trims whole turns, never splitting a tool call from its result', () => {
    const history: ChatMessage[] = []
    for (let i = 0; i < MAX_HISTORY_TURNS + 2; i++) recordAnalysis(history, `T${i}`, analysis())
    expect(history.filter((m) => m.role === 'user')).toHaveLength(MAX_HISTORY_TURNS)
    expect(history[0]).toEqual({ role: 'user', text: '/analyze T2' })

    const short: ChatMessage[] = [{ role: 'user', text: 'a' }]
    trimHistory(short)
    expect(short).toHaveLength(1)
  })
})

describe('askAgent with injected services', () => {
  it('uses the given market data and consideration store, touching neither the network nor the disk', async () => {
    const stored: string[] = ['tariffs']
    const quoteCalls: string[][] = []
    const services: Services = {
      market: {
        ...market,
        quotes: async (tickers) => {
          quoteCalls.push(tickers)
          return { quotes: [quote()], missing: [] }
        }
      },
      considerations: {
        location: 'memory',
        list: () => [...stored],
        add: (text) => void stored.push(text),
        remove: (text) => stored.filter((c) => c !== text)
      }
    }
    const llm = new FakeLLM([
      calls(call('get_stock_quote', { tickers: ['AAPL'] }), call('remember_consideration', { text: 'insider selling' })),
      say('AAPL is up.')
    ])
    const result = await askAgent(llm, 'apple?', [], {}, services)
    expect(result.text).toBe('AAPL is up.')
    expect(quoteCalls).toEqual([['AAPL']])
    expect(stored).toEqual(['tariffs', 'insider selling'])
    expect(llm.requests[0].system).toContain('- tariffs')
    expect(loadConsiderations()).toEqual([]) // the real store was never written
  })
})
