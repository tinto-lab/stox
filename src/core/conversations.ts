import fs from 'node:fs'
import path from 'node:path'
import type { AgentResult, ConversationSummary, SavedTurn } from '../shared/types'
import { configDir } from './config'
import { type ChatMessage, type ChatModel, buildLLM } from './llm'

/**
 * Saved chat conversations, so one can be picked up again later -- in the
 * CLI or the app, which share the folder. One JSON file per conversation
 * under ~/.config/stox/conversations/, plain text, safe to delete.
 *
 * Only questions the user asked are saved (with any analysis the agent ran
 * to answer them); a typed /analyze or /price isn't. Each is titled with a
 * short summary of its first question, written by the model before the
 * first save. If the CLI and the app both have the same conversation open,
 * the last one to save wins.
 */

export const MAX_SAVED_CONVERSATIONS = 100
export const MAX_SAVED_TURNS = 200
const TITLE_LENGTH = 60
const TITLE_TIMEOUT_MS = 15_000

const TITLE_SYSTEM =
  'Write a title for a conversation with a stock research assistant, summarizing the question it opens ' +
  'with in at most six words -- like "Apple share price" or "Tesla risk outlook". Use the language of ' +
  'the question. Reply with the title alone: no quotes, no trailing punctuation.'

/** Makes a conversation's title from its first question. */
export type Titler = (question: string) => Promise<string>

/** A short title summarizing `question`, from the model. Gives up after
 * TITLE_TIMEOUT_MS, so a slow provider can't hold the save up for long. */
export async function summarizeTitle(llm: ChatModel, question: string): Promise<string> {
  const reply = await llm.complete({
    system: TITLE_SYSTEM,
    messages: [{ role: 'user', text: question }],
    signal: AbortSignal.timeout(TITLE_TIMEOUT_MS)
  })
  return reply.text
}

/** Titles with the configured model, thinking off: a title isn't worth the wait. */
export const modelTitler: Titler = (question) => summarizeTitle(buildLLM({ thinking: false }), question)

interface SavedConversation {
  version: 1
  id: string
  title: string
  createdAt: string
  updatedAt: string
  /** What the model sees on resume: the (trimmed) history, ask turns only. */
  history: ChatMessage[]
  /** What the user saw, for re-showing on resume. */
  turns: SavedTurn[]
}

export function conversationsDir(): string {
  return path.join(configDir(), 'conversations')
}

// Ids come back from the renderer: never let one name a path outside the folder.
const ID_PATTERN = /^[A-Za-z0-9-]+$/

function conversationPath(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error(`invalid conversation id: ${id}`)
  return path.join(conversationsDir(), `${id}.json`)
}

function newId(): string {
  // Sortable by eye: 20261004-153012-k3x9
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`
}

function makeTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > TITLE_LENGTH ? `${flat.slice(0, TITLE_LENGTH - 1)}…` : flat
}

/** The model's title tidied up: first line, no "Title:", quotes or end punctuation. */
export function cleanTitle(raw: string): string {
  const line = raw.trim().split('\n')[0] ?? ''
  return makeTitle(
    line
      .replace(/^title\s*:\s*/i, '')
      .replace(/^["'“”‘’「」*]+|["'“”‘’「」*]+$/g, '')
      .replace(/[.。!！?？:：]+$/, '')
  )
}

/** A title for a conversation opening with `question`: the titler's, or
 * the question itself, shortened, if there's no titler or it fails. */
async function titleFor(question: string, titler?: Titler): Promise<string> {
  if (titler) {
    try {
      const title = cleanTitle(await titler(question))
      if (title) return title
    } catch {
      // offline, slow or refusing: the question will do
    }
  }
  return makeTitle(question)
}

/** Drops the turns a typed /analyze added (recordAnalysis): they stay in
 * the live history for this session's follow-ups, but aren't saved. */
export function withoutTypedAnalyses(history: ChatMessage[]): ChatMessage[] {
  const kept: ChatMessage[] = []
  let skipping = false
  for (const m of history) {
    if (m.role === 'user') skipping = m.text.startsWith('/analyze ')
    if (!skipping) kept.push(m)
  }
  return kept
}

function parse(text: string): SavedConversation {
  const parsed = JSON.parse(text) as Partial<SavedConversation>
  if (parsed.version !== 1 || typeof parsed.id !== 'string' || !Array.isArray(parsed.history) || !Array.isArray(parsed.turns)) {
    throw new Error('not a saved conversation')
  }
  return parsed as SavedConversation
}

function readSaved(id: string): SavedConversation {
  const file = conversationPath(id)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    throw new Error(`no saved conversation ${id}`)
  }
  try {
    return parse(text)
  } catch {
    throw new Error(`saved conversation ${id} is unreadable`)
  }
}

function writeSaved(conv: SavedConversation): void {
  const file = conversationPath(conv.id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Write-then-rename, so quitting mid-write can't leave a half-written file.
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(conv) + '\n')
  fs.renameSync(tmp, file)
  prune()
}

/** Keeps the MAX_SAVED_CONVERSATIONS most recently saved files. */
function prune(): void {
  const dir = conversationsDir()
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
  if (files.length <= MAX_SAVED_CONVERSATIONS) return
  files.sort((a, b) => b.mtime - a.mtime)
  for (const { file } of files.slice(MAX_SAVED_CONVERSATIONS)) fs.rmSync(file, { force: true })
}

/** The saved conversations, most recently updated first; unreadable files are skipped. */
export function listConversations(limit = MAX_SAVED_CONVERSATIONS): ConversationSummary[] {
  let names: string[]
  try {
    names = fs.readdirSync(conversationsDir()).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const summaries: ConversationSummary[] = []
  for (const name of names) {
    try {
      const conv = parse(fs.readFileSync(path.join(conversationsDir(), name), 'utf8'))
      summaries.push({ id: conv.id, title: conv.title, updatedAt: conv.updatedAt, turnCount: conv.turns.length })
    } catch {
      // half-written or hand-edited: not offered for resuming
    }
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit)
}

/**
 * One conversation: the model's history (handed to askAgent, which updates
 * it in place) plus the turns as the user saw them. Saved after each
 * answered question -- not before the first, so a session with no
 * questions leaves no file.
 */
export class Conversation {
  readonly id: string
  history: ChatMessage[]
  turns: SavedTurn[]
  private title: string
  private readonly createdAt: string
  private updatedAt: string
  // Saves run one after another, so a second answer can't be written
  // before the first one's title is back.
  private saving: Promise<void> = Promise.resolve()

  constructor(saved?: SavedConversation) {
    const now = new Date().toISOString()
    this.id = saved?.id ?? newId()
    this.title = saved?.title ?? ''
    this.createdAt = saved?.createdAt ?? now
    this.updatedAt = saved?.updatedAt ?? now
    this.history = saved ? [...saved.history] : []
    this.turns = saved ? [...saved.turns] : []
  }

  /** Loads a saved conversation; throws if it's missing or unreadable. */
  static resume(id: string): Conversation {
    return new Conversation(readSaved(id))
  }

  /** The most recently updated saved conversation, if any. */
  static latest(): Conversation | null {
    const [newest] = listConversations(1)
    return newest ? Conversation.resume(newest.id) : null
  }

  get summary(): ConversationSummary {
    return { id: this.id, title: this.title, updatedAt: this.updatedAt, turnCount: this.turns.length }
  }

  /**
   * Call after askAgent answered `text` (and appended the turn to
   * `history`). The turn is recorded at once; the returned promise settles
   * once it's on disk -- for the first question, after `titler` has named
   * the conversation. Rejects if the file can't be written.
   */
  recordAsk(text: string, result: AgentResult, titler?: Titler): Promise<void> {
    this.updatedAt = new Date().toISOString()
    this.turns.push({ text, result, at: this.updatedAt })
    if (this.turns.length > MAX_SAVED_TURNS) this.turns.splice(0, this.turns.length - MAX_SAVED_TURNS)
    const save = async (): Promise<void> => {
      if (!this.title) this.title = await titleFor(this.turns[0].text, titler)
      writeSaved({
        version: 1,
        id: this.id,
        title: this.title,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
        history: withoutTypedAnalyses(this.history),
        turns: this.turns
      })
    }
    this.saving = this.saving.then(save, save)
    return this.saving
  }
}
