import { vi } from 'vitest'
import type { AssistantMessage, ChatModel, CompletionRequest, ToolCall } from '../src/core/llm'
import type { Article, Bar, Fundamentals, GeoArticle, Quote } from '../src/shared/types'

/** A scripted model: each complete() returns the next reply and records the request. */
export class FakeLLM implements ChatModel {
  readonly name = 'fake/model'
  readonly requests: CompletionRequest[] = []
  private next = 0

  constructor(private readonly replies: (AssistantMessage | ((req: CompletionRequest) => AssistantMessage))[]) {}

  async complete(request: CompletionRequest): Promise<AssistantMessage> {
    // Snapshot: the caller keeps appending to the same messages array.
    this.requests.push({ ...request, messages: [...request.messages] })
    const reply = this.replies[this.next++]
    if (!reply) throw new Error('FakeLLM ran out of replies')
    return typeof reply === 'function' ? reply(request) : reply
  }
}

export const say = (text: string): AssistantMessage => ({ role: 'assistant', text, toolCalls: [] })

let callCounter = 0
export function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `call_${++callCounter}`, name, args }
}
export const calls = (...toolCalls: ToolCall[]): AssistantMessage => ({ role: 'assistant', text: '', toolCalls })

export const quote = (code = 'AAPL.US'): Quote => ({
  code,
  price: 227.14,
  change: 3.04,
  percent: 1.36,
  open: 225,
  high: 228,
  low: 224.5,
  prevClose: 224.1,
  volume: 50_000_000,
  timestamp: null
})

export const article = (title = 'Apple hits new high', link = 'https://example.com/a'): Article => ({
  title,
  date: '2026-01-01T12:00:00+00:00',
  link,
  symbols: ['AAPL.US'],
  sentiment: { polarity: 0.9 },
  summary: 'Some summary.'
})

export const geoArticle = (title = 'Taiwan tightens chip export rules', link = 'https://example.com/g'): GeoArticle => ({
  title,
  date: '2026-01-01T12:00:00+00:00',
  link,
  country: 'TW',
  sentiment: 'negative',
  summary: 'Some summary.'
})

export const bar = (date = '2026-01-01', close = 227.14): Bar => ({
  date,
  open: 225,
  high: 228,
  low: 224.5,
  close,
  volume: 50_000_000
})

export const fundamentals = (code = 'AAPL.US'): Fundamentals => ({
  code,
  yahooSymbol: 'AAPL',
  name: 'Apple Inc.',
  sector: 'Technology',
  industry: 'Consumer Electronics',
  country: 'United States',
  website: null,
  employees: null,
  summary: null,
  currency: 'USD',
  marketCap: 4.85e12,
  enterpriseValue: null,
  trailingPE: 38.03,
  forwardPE: 31.2,
  pegRatio: 2.66,
  priceToBook: null,
  priceToSales: null,
  eps: 8.74,
  forwardEps: null,
  dividendYield: 0.0032,
  payoutRatio: null,
  beta: null,
  fiftyTwoWeekLow: null,
  fiftyTwoWeekHigh: null,
  grossMargin: null,
  operatingMargin: 0.3262,
  profitMargin: 0.2762,
  roe: 1.4875,
  roa: 0.2708,
  revenueTtm: 4.67e11,
  revenueGrowth: 0.164,
  earningsGrowth: 0.287,
  ebitda: 1.68e11,
  freeCashflow: null,
  totalCash: null,
  totalDebt: null,
  debtToEquity: null,
  currentRatio: null,
  targetMeanPrice: 327.2,
  recommendation: null,
  analystCount: null
})

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>

/** Stubs global fetch: the first route whose prefix the URL starts with
 * answers; anything unrouted fails the test loudly. Returns the mock. */
export function stubFetch(routes: Record<string, Route>) {
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    for (const [prefix, route] of Object.entries(routes)) {
      if (url.href.startsWith(prefix)) return route(url, init)
    }
    throw new Error(`unexpected fetch: ${url.href}`)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

export const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

/** A scripted model for concurrent agents: each request is routed to a
 * queue of replies by which agent sent it (recognized from its system
 * prompt), since the analysis specialists' calls interleave. */
export class RoutedLLM implements ChatModel {
  readonly name = 'fake/routed'
  readonly requests: { agent: string; request: CompletionRequest }[] = []

  constructor(private readonly queues: Record<string, (AssistantMessage | ((req: CompletionRequest) => AssistantMessage))[]>) {}

  static agentOf(system: string): string {
    if (system.startsWith('You are stox, ')) return 'main'
    const m = /stox's (trend|fundamentals|news|geopolitics) analyst|stox's (aggregator)/.exec(system)
    if (!m) throw new Error(`unrecognized system prompt: ${system.slice(0, 60)}`)
    return m[1] ?? m[2]
  }

  async complete(request: CompletionRequest): Promise<AssistantMessage> {
    const agent = RoutedLLM.agentOf(request.system)
    this.requests.push({ agent, request: { ...request, messages: [...request.messages] } })
    const reply = this.queues[agent]?.shift()
    if (!reply) throw new Error(`RoutedLLM: no reply left for ${agent}`)
    return typeof reply === 'function' ? reply(request) : reply
  }

  requestsOf(agent: string): CompletionRequest[] {
    return this.requests.filter((r) => r.agent === agent).map((r) => r.request)
  }
}
