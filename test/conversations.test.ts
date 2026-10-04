import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { recordAnalysis } from '../src/core/agent'
import {
  Conversation,
  MAX_SAVED_CONVERSATIONS,
  type Titler,
  cleanTitle,
  summarizeTitle,
  MAX_SAVED_TURNS,
  conversationsDir,
  listConversations,
  withoutTypedAnalyses
} from '../src/core/conversations'
import type { ChatMessage } from '../src/core/llm'
import type { AgentResult, AnalysisResult } from '../src/shared/types'
import { FakeLLM, quote, say } from './helpers'

const answer = (text: string): AgentResult => ({
  text,
  quotes: [quote()],
  articles: [],
  geoArticles: [],
  bars: [],
  fundamentals: null,
  analysis: null
})

/** What askAgent leaves in history after answering `q` with `a`, then the save. */
function ask(conv: Conversation, q: string, a: string, titler?: Titler): Promise<void> {
  conv.history.push({ role: 'user', text: q }, { role: 'assistant', text: a, toolCalls: [] })
  return conv.recordAsk(q, answer(a), titler)
}

const analysis = (): AnalysisResult => ({
  ticker: 'AAPL.US',
  trendText: '',
  fundamentalsText: '',
  newsText: '',
  geopoliticsText: '',
  verdictText: 'Hold.',
  quotes: [],
  bars: [],
  articles: [],
  geoArticles: [],
  fundamentals: null
})

const savedFiles = (): string[] => {
  try {
    return fs.readdirSync(conversationsDir()).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
}

describe('conversations', () => {
  it('lives under HOME, so tests never touch the real ~/.config/stox', () => {
    expect(conversationsDir()).toBe(path.join(process.env.HOME!, '.config', 'stox', 'conversations'))
  })

  it('writes nothing until the first question is answered', async () => {
    const conv = new Conversation()
    recordAnalysis(conv.history, 'AAPL.US', analysis())
    expect(savedFiles()).toEqual([])
    expect(listConversations()).toEqual([])
  })

  it('round-trips the history and turns, titled after the first question', async () => {
    const conv = new Conversation()
    await ask(conv, "what's apple trading at?", 'AAPL is 227.')
    await ask(conv, 'and its news?', 'Nothing new.')

    const resumed = Conversation.resume(conv.id)
    expect(resumed.history).toEqual(conv.history)
    expect(resumed.turns.map((t) => [t.text, t.result.text])).toEqual([
      ["what's apple trading at?", 'AAPL is 227.'],
      ['and its news?', 'Nothing new.']
    ])
    expect(resumed.turns[0].result.quotes).toEqual([quote()])
    expect(resumed.summary).toMatchObject({ id: conv.id, title: "what's apple trading at?", turnCount: 2 })
  })

  it('shortens long titles', async () => {
    const conv = new Conversation()
    await ask(conv, 'x'.repeat(200), 'ok')
    const { title } = listConversations()[0]
    expect(title).toHaveLength(60)
    expect(title.endsWith('…')).toBe(true)
  })

  it('lists newest first, and latest() resumes the newest', async () => {
    const older = new Conversation()
    await ask(older, 'older', 'a')
    await new Promise((r) => setTimeout(r, 5))
    const newer = new Conversation()
    await ask(newer, 'newer', 'b')
    expect(listConversations().map((c) => c.title)).toEqual(['newer', 'older'])
    expect(listConversations(1).map((c) => c.title)).toEqual(['newer'])
    expect(Conversation.latest()?.id).toBe(newer.id)
  })

  it('leaves typed /analyze turns out of the saved history', async () => {
    const conv = new Conversation()
    await ask(conv, 'first', 'one')
    recordAnalysis(conv.history, 'AAPL.US', analysis())
    await ask(conv, 'second', 'two')
    expect(conv.history.some((m) => m.role === 'user' && m.text.startsWith('/analyze'))).toBe(true)
    expect(Conversation.resume(conv.id).history).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'one', toolCalls: [] },
      { role: 'user', text: 'second' },
      { role: 'assistant', text: 'two', toolCalls: [] }
    ])
  })

  it('withoutTypedAnalyses keeps an analysis the agent ran inside a question', () => {
    const history: ChatMessage[] = [
      { role: 'user', text: 'should I buy apple?' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'analyze_stock', args: { ticker: 'AAPL' } }] },
      { role: 'tool', toolCallId: 'c1', content: 'verdict: Hold' },
      { role: 'assistant', text: 'Hold.', toolCalls: [] }
    ]
    expect(withoutTypedAnalyses(history)).toEqual(history)
  })

  it('skips unreadable files in the list, and says so when resuming one', async () => {
    const conv = new Conversation()
    await ask(conv, 'fine', 'ok')
    fs.writeFileSync(path.join(conversationsDir(), 'broken.json'), '{ not json')
    expect(listConversations().map((c) => c.title)).toEqual(['fine'])
    expect(() => Conversation.resume('broken')).toThrow('saved conversation broken is unreadable')
    expect(() => Conversation.resume('missing')).toThrow('no saved conversation missing')
    expect(() => Conversation.resume('../../.env')).toThrow('invalid conversation id')
  })

  it(`keeps the ${MAX_SAVED_TURNS} latest turns`, async () => {
    const conv = new Conversation()
    for (let i = 0; i < MAX_SAVED_TURNS + 3; i++) await conv.recordAsk(`q${i}`, answer(`a${i}`))
    const { turns } = Conversation.resume(conv.id)
    expect(turns).toHaveLength(MAX_SAVED_TURNS)
    expect(turns[0].text).toBe('q3')
  })

  it(`keeps the ${MAX_SAVED_CONVERSATIONS} most recently saved conversations`, async () => {
    fs.mkdirSync(conversationsDir(), { recursive: true })
    const old = Date.now() / 1000 - 3600
    for (let i = 0; i < MAX_SAVED_CONVERSATIONS; i++) {
      const file = path.join(conversationsDir(), `old-${i}.json`)
      fs.writeFileSync(file, '{}')
      fs.utimesSync(file, old + i, old + i)
    }
    const conv = new Conversation()
    await ask(conv, 'new', 'ok')
    const files = savedFiles()
    expect(files).toHaveLength(MAX_SAVED_CONVERSATIONS)
    expect(files).toContain(`${conv.id}.json`)
    expect(files).not.toContain('old-0.json')
  })
  it('titles a conversation with the titler, once, before the first save', async () => {
    const asked: string[] = []
    const titler: Titler = async (q) => {
      asked.push(q)
      expect(savedFiles()).toEqual([]) // nothing on disk until the title is back
      return '"Apple share price."'
    }
    const conv = new Conversation()
    const first = ask(conv, "what's apple trading at?", 'AAPL is 227.', titler)
    const second = ask(conv, 'and its news?', 'Nothing new.', titler)
    await Promise.all([first, second])
    expect(asked).toEqual(["what's apple trading at?"])
    expect(listConversations()).toMatchObject([{ title: 'Apple share price', turnCount: 2 }])
  })

  it('falls back to the question when the titler fails or says nothing', async () => {
    const failing = new Conversation()
    await ask(failing, 'apple?', 'ok', async () => {
      throw new Error('offline')
    })
    const blank = new Conversation()
    await ask(blank, 'tesla?', 'ok', async () => '  ')
    expect(listConversations().map((c) => c.title).sort()).toEqual(['apple?', 'tesla?'])
  })

  it('rejects when the file cannot be written', async () => {
    fs.mkdirSync(path.dirname(conversationsDir()), { recursive: true })
    fs.writeFileSync(conversationsDir(), 'a file where the folder should be')
    await expect(ask(new Conversation(), 'apple?', 'ok')).rejects.toThrow()
  })

  it('cleanTitle keeps the first line, minus labels, quotes and end punctuation', () => {
    expect(cleanTitle('Title: "Tesla risk outlook."\nextra')).toBe('Tesla risk outlook')
    expect(cleanTitle('「苹果股价」')).toBe('苹果股价')
    expect(cleanTitle('**Nvidia earnings preview**')).toBe('Nvidia earnings preview')
    expect(cleanTitle('x'.repeat(100))).toHaveLength(60)
  })

  it('summarizeTitle asks the model with the question alone', async () => {
    const llm = new FakeLLM([say('Apple share price')])
    expect(await summarizeTitle(llm, "what's apple at?")).toBe('Apple share price')
    expect(llm.requests[0].messages).toEqual([{ role: 'user', text: "what's apple at?" }])
    expect(llm.requests[0].tools).toBeUndefined()
    expect(llm.requests[0].system).toContain('at most six words')
  })
})
