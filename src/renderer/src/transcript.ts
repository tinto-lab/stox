import type {
  AnalysisResult,
  Article,
  Bar,
  Fundamentals,
  GeoArticle,
  Quote,
  ResumedConversation
} from '../../shared/types'

/** The chat panel's transcript: its row types and the pure functions that
 * grow it as bridge events arrive. */

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
export function endReasoning(items: TranscriptItem[], id: string, agent?: string | null): TranscriptItem[] {
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
export function addReasoning(items: TranscriptItem[], id: string, agent: string | null, step: number, delta: string): TranscriptItem[] {
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
export function dropStreamedText(items: TranscriptItem[], id: string): TranscriptItem[] {
  return items.some((item) => item.kind === 'streaming_text' && item.id === id)
    ? items.filter((item) => !(item.kind === 'streaming_text' && item.id === id))
    : items
}

export function addText(items: TranscriptItem[], id: string, delta: string): TranscriptItem[] {
  const last = items.at(-1)
  if (last?.kind === 'streaming_text' && last.id === id) return [...items.slice(0, -1), { ...last, text: last.text + delta }]
  return [...items, { kind: 'streaming_text', id, text: delta }]
}

/** A saved conversation's turns as transcript rows, then a divider saying
 * the panels above are as they were then. */
export function resumedTranscript(conversation: ResumedConversation): TranscriptItem[] {
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

export function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
