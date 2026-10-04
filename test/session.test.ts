import { beforeEach, describe, expect, it, vi } from 'vitest'
import { data } from './mocks'
import type { BridgeEvent } from '../src/shared/bridgeProtocol'
import type { ChatModel } from '../src/core/llm'
import { quote } from './helpers'

// The session builds its model from the environment; hand it a scripted one.
const llmHolder = vi.hoisted(() => ({ current: null as ChatModel | null }))
vi.mock('../src/core/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/llm')>()
  return {
    ...actual,
    buildLLM: () => {
      if (!llmHolder.current) throw new actual.AgentError('no DEEPSEEK_API_KEY set for provider')
      return llmHolder.current
    }
  }
})

const { ChatSession } = await import('../src/core/session')
const { FakeLLM, RoutedLLM, call, calls, say } = await import('./helpers')

function session() {
  const events: BridgeEvent[] = []
  const chat = new ChatSession((e) => events.push(e))
  const settle = () => new Promise((r) => setTimeout(r, 20))
  return { chat, events, settle }
}

beforeEach(() => {
  for (const fn of Object.values(data)) fn.mockReset()
  llmHolder.current = null
})

describe('ChatSession', () => {
  it('answers a quote command', async () => {
    data.fetchQuotes.mockResolvedValue({ quotes: [quote()], missing: ['NOPE.US'] })
    const { chat, events, settle } = session()
    chat.handle({ id: 'q1', cmd: 'quote', tickers: ['AAPL', 'NOPE'] })
    await settle()
    expect(events).toEqual([{ id: 'q1', type: 'result', data: { quotes: [quote()], missing: ['NOPE.US'] } }])
  })

  it('streams tool calls before the result of an ask', async () => {
    data.fetchQuotes.mockResolvedValue({ quotes: [quote()], missing: [] })
    llmHolder.current = new FakeLLM([calls(call('get_stock_quote', { tickers: ['AAPL'] })), say('AAPL is up.')])
    const { chat, events, settle } = session()
    chat.handle({ id: 'a1', cmd: 'ask', text: 'apple?' })
    await settle()
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'result'])
    expect(events[0]).toEqual({ id: 'a1', type: 'tool_call', name: 'get_stock_quote', args: { tickers: ['AAPL'] } })
    expect(events[1]).toMatchObject({ id: 'a1', data: { text: 'AAPL is up.', quotes: [quote()] } })
  })

  it('reports a missing provider key as an error for that request', async () => {
    const { chat, events, settle } = session()
    chat.handle({ id: 'a1', cmd: 'ask', text: 'hi' })
    await settle()
    expect(events).toEqual([{ id: 'a1', type: 'error', message: 'no DEEPSEEK_API_KEY set for provider' }])
  })

  it('keeps conversation history across asks until reset', async () => {
    const llm = new FakeLLM([say('one'), say('two'), say('three')])
    llmHolder.current = llm
    const { chat, settle } = session()
    chat.handle({ id: '1', cmd: 'ask', text: 'first' })
    chat.handle({ id: '2', cmd: 'ask', text: 'second' })
    await settle()
    expect(llm.requests[1].messages).toHaveLength(3)
    chat.handle({ id: '3', cmd: 'reset' })
    chat.handle({ id: '4', cmd: 'ask', text: 'third' })
    await settle()
    expect(llm.requests[2].messages).toHaveLength(1)
  })

  it('runs an analysis with specialist progress, and records it for follow-ups', async () => {
    data.fetchQuotes.mockResolvedValue({ quotes: [quote()], missing: [] })
    const llm = new RoutedLLM({
      trend: [say('trend')],
      fundamentals: [say('fundamentals')],
      news: [say('news')],
      geopolitics: [say('geo')],
      aggregator: [say('Hold.')],
      main: [say('Because of the tariffs.')]
    })
    llmHolder.current = llm
    const { chat, events, settle } = session()
    chat.handle({ id: 'x', cmd: 'analyze', ticker: 'aapl' })
    chat.handle({ id: 'y', cmd: 'ask', text: 'why hold?' })
    await settle()
    expect(events.filter((e) => e.type === 'specialist_start').map((e) => (e as { name: string }).name)).toEqual([
      'trend',
      'fundamentals',
      'news',
      'geopolitics',
      'aggregator'
    ])
    expect(events.find((e) => e.id === 'x' && e.type === 'result')).toMatchObject({ data: { verdictText: 'Hold.' } })
    const followUp = llm.requestsOf('main')[0].messages
    expect(followUp[0]).toEqual({ role: 'user', text: '/analyze AAPL.US' })
  })

  it('adds, lists and removes considerations, and reports status', async () => {
    process.env.STOX_LLM_PROVIDER = 'deepseek'
    process.env.DEEPSEEK_API_KEY = 'k'
    const { chat, events, settle } = session()
    chat.handle({ id: '1', cmd: 'considerations_add', text: 'tariffs' })
    chat.handle({ id: '2', cmd: 'considerations_add', text: 'insider selling' })
    await settle()
    chat.handle({ id: '3', cmd: 'considerations_remove', text: 'tariffs' })
    chat.handle({ id: '4', cmd: 'considerations_list' })
    chat.handle({ id: '5', cmd: 'status' })
    await settle()
    const data_ = Object.fromEntries(events.map((e) => [e.id, (e as { data: unknown }).data]))
    expect(data_['2']).toEqual({ considerations: ['tariffs', 'insider selling'] })
    expect(data_['3']).toEqual({ considerations: ['insider selling'] })
    expect(data_['4']).toEqual({ considerations: ['insider selling'] })
    expect(data_['5']).toEqual({
      eodhdKey: false,
      provider: 'deepseek',
      model: 'deepseek/deepseek-chat',
      providerKeyPresent: true,
      thinking: false
    })
  })

  it('streams reasoning events, numbered per model call and attributed to the agent', async () => {
    process.env.STOX_LLM_PROVIDER = 'deepseek'
    process.env.STOX_LLM_THINKING = 'on'
    data.fetchQuotes.mockResolvedValue({ quotes: [quote()], missing: [] })
    const think = (text: string, reply: ReturnType<typeof say>) => (req: { onReasoning?: (d: string) => void }) => {
      req.onReasoning?.(text)
      return reply
    }
    llmHolder.current = new FakeLLM([
      think('Need a quote.', calls(call('get_stock_quote', { tickers: ['AAPL'] }))),
      think('Got it.', say('AAPL is up.'))
    ])
    const { chat, events, settle } = session()
    chat.handle({ id: 'a', cmd: 'ask', text: 'apple?' })
    await settle()
    // Each model call opens with an empty delta marking its start.
    expect(events.map((e) => (e.type === 'reasoning' ? `reasoning ${e.step}:${e.delta}` : e.type))).toEqual([
      'reasoning 1:',
      'reasoning 1:Need a quote.',
      'tool_call',
      'reasoning 2:',
      'reasoning 2:Got it.',
      'result'
    ])
    expect(events[1]).toEqual({ id: 'a', type: 'reasoning', agent: null, step: 1, delta: 'Need a quote.' })

    llmHolder.current = new RoutedLLM({
      trend: [think('Looking at bars.', say('trend'))],
      fundamentals: [say('fundamentals')],
      news: [say('news')],
      geopolitics: [say('geo')],
      aggregator: [think('Weighing it up.', say('Hold.'))]
    })
    chat.handle({ id: 'b', cmd: 'analyze', ticker: 'AAPL' })
    await settle()
    const reasoning = events.filter((e) => e.id === 'b' && e.type === 'reasoning' && e.delta)
    expect(reasoning).toEqual([
      { id: 'b', type: 'reasoning', agent: 'trend', step: 1, delta: 'Looking at bars.' },
      { id: 'b', type: 'reasoning', agent: 'aggregator', step: 1, delta: 'Weighing it up.' }
    ])
  })

  it('switches thinking mode, answering with the new status', async () => {
    process.env.STOX_LLM_PROVIDER = 'deepseek'
    const { chat, events, settle } = session()
    chat.handle({ id: 't', cmd: 'set_thinking', enabled: true })
    await settle()
    expect(events[0]).toMatchObject({ id: 't', type: 'result', data: { thinking: true } })
    expect(process.env.STOX_LLM_THINKING).toBe('on')
  })

  it('reports thinking as unavailable for providers that cannot switch it', async () => {
    process.env.STOX_LLM_PROVIDER = 'openai'
    const { chat, events, settle } = session()
    chat.handle({ id: 't', cmd: 'set_thinking', enabled: true })
    await settle()
    expect(events[0]).toMatchObject({ data: { provider: 'openai', thinking: null } })
    expect(process.env.STOX_LLM_THINKING).toBeUndefined()
  })

  it('rejects an unknown command', async () => {
    const { chat, events, settle } = session()
    chat.handle({ id: 'z', cmd: 'launch' } as never)
    await settle()
    expect(events).toEqual([{ id: 'z', type: 'error', message: 'unknown command: launch' }])
  })

  it('restart drops in-flight and queued requests and starts a fresh conversation', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const llm = new FakeLLM([])
    llm.complete = async (request) => {
      llm.requests.push({ ...request, messages: [...request.messages] })
      if (llm.requests.length === 1) await gate
      return say(`reply ${llm.requests.length}`)
    }
    llmHolder.current = llm
    const { chat, events, settle } = session()
    chat.handle({ id: 'slow', cmd: 'ask', text: 'first' })
    chat.handle({ id: 'queued', cmd: 'ask', text: 'second' })
    await settle()
    chat.restart()
    release()
    chat.handle({ id: 'fresh', cmd: 'ask', text: 'third' })
    await settle()
    expect(events).toEqual([
      { id: null, type: 'backend_exit', message: null },
      expect.objectContaining({ id: 'fresh', type: 'result' })
    ])
    expect(llm.requests.at(-1)!.messages).toHaveLength(1)
  })
})
