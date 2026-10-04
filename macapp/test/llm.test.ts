import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentError,
  AnthropicChatModel,
  type ChatMessage,
  OpenAIChatModel,
  buildLLM,
  currentProviderName,
  describeCurrent,
  providerKeyPresent,
  runToolLoop,
  toAnthropicMessages,
  toOpenAIMessages
} from '../src/core/llm'
import { FakeLLM, call, calls, say } from './helpers'

const conversation: ChatMessage[] = [
  { role: 'user', text: 'price and news for AAPL?' },
  {
    role: 'assistant',
    text: 'Looking.',
    toolCalls: [
      { id: 't1', name: 'get_stock_quote', args: { tickers: ['AAPL'] } },
      { id: 't2', name: 'get_stock_news', args: { tickers: ['AAPL'] } }
    ]
  },
  { role: 'tool', toolCallId: 't1', content: 'AAPL.US: price=1' },
  { role: 'tool', toolCallId: 't2', content: 'no recent news found' },
  { role: 'assistant', text: 'AAPL is at 1.', toolCalls: [] }
]

describe('provider registry', () => {
  it('defaults to anthropic and its default model, honoring overrides', () => {
    expect(currentProviderName()).toBe('anthropic')
    expect(describeCurrent()).toBe('anthropic/claude-opus-5')
    process.env.STOX_LLM_PROVIDER = 'DeepSeek'
    expect(describeCurrent()).toBe('deepseek/deepseek-chat')
    process.env.STOX_LLM_MODEL = 'deepseek-reasoner'
    expect(describeCurrent()).toBe('deepseek/deepseek-reasoner')
    process.env.STOX_LLM_PROVIDER = 'nope'
    expect(describeCurrent()).toBe('nope')
  })

  it('refuses an unknown provider or a missing key', () => {
    process.env.STOX_LLM_PROVIDER = 'nope'
    expect(() => buildLLM()).toThrow(/unknown STOX_LLM_PROVIDER 'nope' -- choose from: anthropic, deepseek, openai/)
    process.env.STOX_LLM_PROVIDER = 'openai'
    expect(providerKeyPresent()).toBe(false)
    expect(() => buildLLM()).toThrow(AgentError)
    expect(() => buildLLM()).toThrow(/no OPENAI_API_KEY set/)
  })

  it('builds a model for the configured provider and model', () => {
    process.env.STOX_LLM_PROVIDER = 'deepseek'
    process.env.DEEPSEEK_API_KEY = 'k'
    process.env.STOX_LLM_MODEL = 'deepseek-reasoner'
    expect(providerKeyPresent()).toBe(true)
    const llm = buildLLM()
    expect(llm).toBeInstanceOf(OpenAIChatModel)
    expect(llm.name).toBe('deepseek/deepseek-reasoner')
  })
})

describe('Anthropic adapter', () => {
  it('sends parallel tool results back in a single user message', () => {
    expect(toAnthropicMessages(conversation)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'price and news for AAPL?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Looking.' },
          { type: 'tool_use', id: 't1', name: 'get_stock_quote', input: { tickers: ['AAPL'] } },
          { type: 'tool_use', id: 't2', name: 'get_stock_news', input: { tickers: ['AAPL'] } }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'AAPL.US: price=1' },
          { type: 'tool_result', tool_use_id: 't2', content: 'no recent news found' }
        ]
      },
      { role: 'assistant', content: [{ type: 'text', text: 'AAPL is at 1.' }] }
    ])
  })

  it("echoes the provider's own content (thinking blocks included) verbatim", () => {
    const raw = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'hi' }]
    const out = toAnthropicMessages([
      { role: 'user', text: 'q' },
      { role: 'assistant', text: 'hi', toolCalls: [], raw: { provider: 'anthropic', content: raw } }
    ])
    expect(out[1]).toEqual({ role: 'assistant', content: raw })
  })

  function fakeClient(response: Partial<Anthropic.Beta.BetaMessage>) {
    const create = vi.fn().mockResolvedValue({ stop_reason: 'end_turn', stop_details: null, ...response })
    return { client: { beta: { messages: { create } } } as unknown as Anthropic, create }
  }

  it('parses text and tool calls, keeps the raw content, and opts into refusal fallbacks', async () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 's' },
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'tu1', name: 'get_stock_quote', input: { tickers: ['AAPL'] } }
    ]
    const { client, create } = fakeClient({ content: content as never, stop_reason: 'tool_use' })
    const reply = await new AnthropicChatModel('claude-opus-5', client).complete({
      system: 'sys',
      messages: [{ role: 'user', text: 'q' }],
      tools: [{ name: 'get_stock_quote', description: 'd', parameters: { type: 'object', properties: {} } }]
    })
    expect(reply.text).toBe('Let me check.')
    expect(reply.toolCalls).toEqual([{ id: 'tu1', name: 'get_stock_quote', args: { tickers: ['AAPL'] } }])
    expect(reply.raw).toEqual({ provider: 'anthropic', content })
    const params = create.mock.calls[0][0]
    expect(params).toMatchObject({
      model: 'claude-opus-5',
      system: 'sys',
      tools: [{ name: 'get_stock_quote', description: 'd', input_schema: { type: 'object', properties: {} } }],
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default'
    })
    expect(params.tool_choice).toBeUndefined()
  })

  it('leaves fallbacks off for models without them, and can forbid tool use', async () => {
    const { client, create } = fakeClient({ content: [{ type: 'text', text: 'ok' }] as never })
    await new AnthropicChatModel('claude-haiku-4-5', client).complete({
      system: 's',
      messages: [{ role: 'user', text: 'q' }],
      tools: [{ name: 't', description: 'd', parameters: {} }],
      forbidToolUse: true
    })
    const params = create.mock.calls[0][0]
    expect(params.fallbacks).toBeUndefined()
    expect(params.tool_choice).toEqual({ type: 'none' })
  })

  it('turns a refusal into an error', async () => {
    const { client } = fakeClient({ content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' } as never })
    await expect(
      new AnthropicChatModel('claude-opus-5', client).complete({ system: 's', messages: [{ role: 'user', text: 'q' }] })
    ).rejects.toThrow(/declined to answer \(cyber\)/)
  })
})

describe('OpenAI-compatible adapter', () => {
  it('converts messages to the chat completions shape', () => {
    expect(toOpenAIMessages(conversation)).toEqual([
      { role: 'user', content: 'price and news for AAPL?' },
      {
        role: 'assistant',
        content: 'Looking.',
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'get_stock_quote', arguments: '{"tickers":["AAPL"]}' } },
          { id: 't2', type: 'function', function: { name: 'get_stock_news', arguments: '{"tickers":["AAPL"]}' } }
        ]
      },
      { role: 'tool', tool_call_id: 't1', content: 'AAPL.US: price=1' },
      { role: 'tool', tool_call_id: 't2', content: 'no recent news found' },
      { role: 'assistant', content: 'AAPL is at 1.' }
    ])
  })

  it('parses tool calls, tolerating malformed arguments', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'get_stock_quote', arguments: '{"tickers":["TSLA"]}' } },
              { id: 'c2', type: 'function', function: { name: 'get_stock_news', arguments: '{oops' } }
            ]
          }
        }
      ]
    })
    const client = { chat: { completions: { create } } } as unknown as OpenAI
    const reply = await new OpenAIChatModel('openai', 'gpt-4o-mini', client).complete({
      system: 'sys',
      messages: [{ role: 'user', text: 'q' }],
      tools: [{ name: 'get_stock_quote', description: 'd', parameters: { type: 'object' } }],
      forbidToolUse: true
    })
    expect(reply).toEqual({
      role: 'assistant',
      text: '',
      toolCalls: [
        { id: 'c1', name: 'get_stock_quote', args: { tickers: ['TSLA'] } },
        { id: 'c2', name: 'get_stock_news', args: {} }
      ]
    })
    const params = create.mock.calls[0][0]
    expect(params.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(params.tools[0]).toEqual({
      type: 'function',
      function: { name: 'get_stock_quote', description: 'd', parameters: { type: 'object' } }
    })
    expect(params.tool_choice).toBe('none')
  })
})

describe('runToolLoop', () => {
  const tools = [{ name: 'lookup', description: 'd', parameters: {} }]

  it('returns straight away when the model calls no tools', async () => {
    const llm = new FakeLLM([say('hi')])
    const messages: ChatMessage[] = [{ role: 'user', text: 'q' }]
    expect(await runToolLoop({ llm, system: 's', messages, tools, dispatch: vi.fn() })).toBe('hi')
    expect(messages).toHaveLength(2)
  })

  it('runs each call (announcing it first), appends results in order, and goes again', async () => {
    const llm = new FakeLLM([calls(call('lookup', { n: 1 }), call('lookup', { n: 2 })), say('done')])
    const order: string[] = []
    const messages: ChatMessage[] = [{ role: 'user', text: 'q' }]
    const text = await runToolLoop({
      llm,
      system: 's',
      messages,
      tools,
      onToolCall: (_name, args) => order.push(`announce ${args.n}`),
      dispatch: async (_name, args) => {
        // the second finishes first: results must still land in call order
        await new Promise((r) => setTimeout(r, args.n === 1 ? 10 : 0))
        order.push(`ran ${args.n}`)
        return `result ${args.n}`
      }
    })
    expect(text).toBe('done')
    expect(order.slice(0, 2)).toEqual(['announce 1', 'announce 2'])
    expect(messages.filter((m) => m.role === 'tool').map((m) => (m as { content: string }).content)).toEqual([
      'result 1',
      'result 2'
    ])
    expect(llm.requests[1].messages).toHaveLength(4)
  })

  it('after the round budget, forces a final answer with tool use forbidden', async () => {
    const llm = new FakeLLM([calls(call('lookup')), calls(call('lookup')), say('final write-up')])
    const messages: ChatMessage[] = [{ role: 'user', text: 'q' }]
    const text = await runToolLoop({
      llm,
      system: 's',
      messages,
      tools,
      dispatch: async () => 'data',
      maxRounds: 2,
      budgetExhaustedNotice: 'answer now'
    })
    expect(text).toBe('final write-up')
    const last = llm.requests[2]
    expect(last.forbidToolUse).toBe(true)
    expect(last.tools).toEqual(tools)
    expect(last.messages.at(-1)).toEqual({ role: 'user', text: 'answer now' })
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runToolLoop({ llm: new FakeLLM([say('x')]), system: 's', messages: [], tools, dispatch: vi.fn(), signal: controller.signal })
    ).rejects.toThrow()
  })
})
