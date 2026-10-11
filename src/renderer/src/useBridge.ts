import { useCallback, useEffect, useRef, useState } from 'react'
import type { BridgeEvent } from '../../shared/bridgeProtocol'
import type {
  AgentResult,
  AnalysisResult,
  Article,
  Bar,
  ChatStatus,
  ConversationSummary,
  Fundamentals,
  GeoArticle,
  Quote,
  QuoteResult,
  ResumedConversation,
  ViewContext
} from '../../shared/types'

export type TranscriptItem =
  | { kind: 'user_message'; id: string; text: string }
  | {
      kind: 'assistant_result'
      id: string
      text: string
      quotes: Quote[]
      articles: Article[]
      geoArticles: GeoArticle[]
      bars: Bar[]
      fundamentals: Fundamentals | null
      analysis: AnalysisResult | null
    }
  | { kind: 'quote_result'; id: string; quotes: Quote[]; missing: string[] }
  | { kind: 'analysis_result'; id: string; analysis: AnalysisResult }
  | { kind: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { kind: 'specialist_start'; id: string; name: string }
  | { kind: 'specialist_tool_call'; id: string; agent: string; name: string; args: Record<string, unknown> }
  | {
      kind: 'reasoning'
      id: string
      /** null for the chat agent, else the /analyze stage. */
      agent: string | null
      step: number
      text: string
      /** When the model call started, and its latest delta: how long it spent reasoning. */
      startedAt: number
      lastAt: number
      /** Set once that model call has moved on (a tool call, the next step, the result). */
      endedAt: number | null
    }
  /** The answer as it streams in; replaced by the assistant_result when the request ends. */
  | { kind: 'streaming_text'; id: string; text: string }
  | { kind: 'error'; id: string; message: string }
  /** A divider, e.g. marking where a resumed conversation picks up. */
  | { kind: 'notice'; id: string; text: string }

type ReasoningItem = Extract<TranscriptItem, { kind: 'reasoning' }>

/** Marks the still-streaming reasoning of request `id` as done -- only
 * `agent`'s, or every agent's when `agent` is undefined. */
function endReasoning(items: TranscriptItem[], id: string, agent?: string | null): TranscriptItem[] {
  const now = Date.now()
  let changed = false
  const next = items.map((item) => {
    if (item.kind !== 'reasoning' || item.id !== id || item.endedAt !== null) return item
    if (agent !== undefined && item.agent !== agent) return item
    changed = true
    return { ...item, endedAt: now }
  })
  return changed ? next : items
}

/** Appends a reasoning delta to its block, starting the block (and ending
 * that agent's previous one) on the first delta of a new step. */
function addReasoning(items: TranscriptItem[], id: string, agent: string | null, step: number, delta: string): TranscriptItem[] {
  let index = items.length - 1
  while (index >= 0) {
    const item = items[index]
    if (item.kind === 'reasoning' && item.id === id && item.agent === agent && item.step === step) break
    index--
  }
  if (index !== -1) {
    const item = items[index] as ReasoningItem
    const next = [...items]
    next[index] = { ...item, text: item.text + delta, lastAt: Date.now() }
    return next
  }
  return [
    ...endReasoning(items, id, agent),
    { kind: 'reasoning', id, agent, step, text: delta, startedAt: Date.now(), lastAt: Date.now(), endedAt: null }
  ]
}

/** Drops request `id`'s streamed text: a model call that went on to call
 * tools, or the result that carries the whole answer. */
function dropStreamedText(items: TranscriptItem[], id: string): TranscriptItem[] {
  return items.some((item) => item.kind === 'streaming_text' && item.id === id)
    ? items.filter((item) => !(item.kind === 'streaming_text' && item.id === id))
    : items
}

function addText(items: TranscriptItem[], id: string, delta: string): TranscriptItem[] {
  const last = items.at(-1)
  if (last?.kind === 'streaming_text' && last.id === id) return [...items.slice(0, -1), { ...last, text: last.text + delta }]
  return [...items, { kind: 'streaming_text', id, text: delta }]
}

type PendingKind = 'ask' | 'quote' | 'analyze' | 'reset' | 'resume'

/** A saved conversation's turns as transcript rows, then a divider saying
 * the panels above are as they were then. */
function resumedTranscript(conversation: ResumedConversation): TranscriptItem[] {
  const items: TranscriptItem[] = conversation.turns.flatMap((turn, index): TranscriptItem[] => {
    const id = `${conversation.id}-${index}`
    return [
      { kind: 'user_message', id, text: turn.text },
      { kind: 'assistant_result', id, ...turn.result }
    ]
  })
  const when = new Date(conversation.updatedAt).toLocaleString()
  items.push({ kind: 'notice', id: makeId(), text: `Resumed conversation from ${when}` })
  return items
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Chat state for the side panel, driven by the main process's ChatSession.
 * `enabled` stays false until the panel is first opened, so a session that
 * only uses the dashboard never asks for the chat's status. */
export function useBridge(enabled: boolean) {
  const [transcript, setTranscript] = useState<TranscriptItem[]>([])
  const [isBusy, setIsBusy] = useState(false)
  const [considerations, setConsiderations] = useState<string[]>([])
  const [status, setStatus] = useState<ChatStatus | null>(null)
  // null while a list is on its way, so the menu doesn't flash an old or empty one.
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null)
  const pending = useRef(new Map<string, PendingKind>())

  const append = useCallback((item: TranscriptItem) => {
    setTranscript((prev) => [...prev, item])
  }, [])

  const refreshConsiderations = useCallback(() => {
    window.stox.send({ id: makeId(), cmd: 'considerations_list' })
  }, [])

  const refreshStatus = useCallback(() => {
    window.stox.send({ id: makeId(), cmd: 'status' })
  }, [])

  useEffect(() => {
    const unsubscribe = window.stox.onEvent((event: BridgeEvent) => {
      if (event.type === 'backend_exit') {
        // Whatever was in flight died with the process and will never be answered.
        pending.current.clear()
        setIsBusy(false)
        if (event.message) append({ kind: 'error', id: makeId(), message: event.message })
        return
      }
      if (event.id === null) {
        if (event.type === 'error') append({ kind: 'error', id: makeId(), message: event.message })
        return
      }

      const id = event.id
      if (event.type === 'text') {
        setTranscript((prev) => addText(prev, id, event.delta))
        return
      }
      if (event.type === 'reasoning') {
        setTranscript((prev) => addReasoning(prev, id, event.agent, event.step, event.delta))
        return
      }
      // Anything else from a request means the model call that was thinking has moved on.
      if (event.type === 'tool_call') {
        setTranscript((prev) => [
          ...endReasoning(dropStreamedText(prev, id), id, null),
          { kind: 'tool_call', id, name: event.name, args: event.args }
        ])
        return
      }
      if (event.type === 'specialist_start') {
        append({ kind: 'specialist_start', id: event.id, name: event.name })
        return
      }
      if (event.type === 'specialist_tool_call') {
        setTranscript((prev) => [
          ...endReasoning(prev, id, event.agent),
          { kind: 'specialist_tool_call', id, agent: event.agent, name: event.name, args: event.args }
        ])
        return
      }

      setTranscript((prev) => endReasoning(dropStreamedText(prev, id), id))
      const requestKind = pending.current.get(event.id)
      pending.current.delete(event.id)
      if (requestKind) setIsBusy(false)

      if (event.type === 'error') {
        append({ kind: 'error', id: event.id, message: event.message })
        return
      }

      switch (requestKind) {
        case 'ask': {
          append({ kind: 'assistant_result', id: event.id, ...(event.data as AgentResult) })
          break
        }
        case 'quote': {
          const data = event.data as QuoteResult
          append({ kind: 'quote_result', id: event.id, quotes: data.quotes, missing: data.missing })
          break
        }
        case 'analyze': {
          append({ kind: 'analysis_result', id: event.id, analysis: event.data as AnalysisResult })
          break
        }
        case 'reset': {
          setTranscript([])
          break
        }
        case 'resume': {
          setTranscript(resumedTranscript(event.data as ResumedConversation))
          break
        }
        default: {
          // considerations_* / conversations_list / status / set_thinking
          const data = event.data as Partial<
            { considerations: string[]; conversations: ConversationSummary[] } & ChatStatus
          >
          if (data.considerations) setConsiderations(data.considerations)
          if (data.conversations) setConversations(data.conversations)
          if (data.provider) setStatus(data as ChatStatus)
        }
      }
    })

    return unsubscribe
  }, [append])

  // Fetched when the chat panel is first opened.
  useEffect(() => {
    if (!enabled) return
    refreshConsiderations()
    refreshStatus()
  }, [enabled, refreshConsiderations, refreshStatus])

  const ask = useCallback(
    (text: string, contexts?: ViewContext[]) => {
      const id = makeId()
      pending.current.set(id, 'ask')
      setIsBusy(true)
      append({ kind: 'user_message', id, text })
      window.stox.send({ id, cmd: 'ask', text, contexts })
    },
    [append]
  )

  const quote = useCallback(
    (tickers: string[]) => {
      const id = makeId()
      pending.current.set(id, 'quote')
      setIsBusy(true)
      append({ kind: 'user_message', id, text: `/price ${tickers.join(' ')}` })
      window.stox.send({ id, cmd: 'quote', tickers })
    },
    [append]
  )

  const analyze = useCallback(
    (ticker: string) => {
      const id = makeId()
      pending.current.set(id, 'analyze')
      setIsBusy(true)
      append({ kind: 'user_message', id, text: `/analyze ${ticker}` })
      window.stox.send({ id, cmd: 'analyze', ticker })
    },
    [append]
  )

  const reset = useCallback(() => {
    const id = makeId()
    pending.current.set(id, 'reset')
    window.stox.send({ id, cmd: 'reset' })
  }, [])

  const listConversations = useCallback(() => {
    setConversations(null)
    window.stox.send({ id: makeId(), cmd: 'conversations_list' })
  }, [])

  const resume = useCallback((conversationId: string) => {
    const id = makeId()
    pending.current.set(id, 'resume')
    setIsBusy(true)
    window.stox.send({ id, cmd: 'resume', conversationId })
  }, [])

  const addConsideration = useCallback((text: string) => {
    window.stox.send({ id: makeId(), cmd: 'considerations_add', text })
  }, [])

  const removeConsideration = useCallback((text: string) => {
    window.stox.send({ id: makeId(), cmd: 'considerations_remove', text })
  }, [])

  // Answered with the updated status, which the default branch above picks up.
  const setThinking = useCallback((enabled: boolean) => {
    window.stox.send({ id: makeId(), cmd: 'set_thinking', enabled })
  }, [])

  return {
    transcript,
    isBusy,
    considerations,
    status,
    conversations,
    ask,
    quote,
    analyze,
    reset,
    listConversations,
    resume,
    addConsideration,
    removeConsideration,
    setThinking,
    refreshStatus
  }
}
