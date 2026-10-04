import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationSummary } from '../../../shared/types'
import { isComposing } from '../keys'
import type { useBridge } from '../useBridge'
import { TranscriptRow } from './TranscriptRow'

type Bridge = ReturnType<typeof useBridge>

/** "5m ago", "3h ago", "2d ago", else the date. */
function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h ago`
  if (minutes < 7 * 24 * 60) return `${Math.round(minutes / (24 * 60))}d ago`
  return new Date(iso).toLocaleDateString()
}

/** Saved conversations to pick one up from, below the History button. */
function HistoryMenu({
  conversations,
  onPick,
  onClose
}: {
  conversations: ConversationSummary[] | null
  onPick: (id: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLUListElement | null>(null)

  // Closes on a click anywhere else, or Escape.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent): void => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <ul className="history-menu" ref={ref} role="menu">
      {conversations === null && <li className="history-empty">Loading…</li>}
      {conversations?.length === 0 && <li className="history-empty">No saved conversations yet.</li>}
      {conversations?.map((c) => (
        <li key={c.id} role="menuitem" onClick={() => onPick(c.id)} title={c.title}>
          <span className="history-title">{c.title}</span>
          <span className="history-meta">{ago(c.updatedAt)}</span>
        </li>
      ))}
    </ul>
  )
}

/** Mirrors the terminal CLI's routing (src/cli/shell.ts): a
 * slash-prefixed line is a command, everything else (including a bare
 * ticker) goes to the agent -- there's no local ticker-detection heuristic
 * on either side. */
function routeInput(raw: string, bridge: Bridge, openHistory: () => void): void {
  const text = raw.trim()
  if (!text) return

  if (text.startsWith('/')) {
    const [word, ...rest] = text.split(/\s+/)
    const command = word.toLowerCase()
    const argText = rest.join(' ').trim()

    if (command === '/price') {
      if (argText) bridge.quote(argText.split(/\s+/))
      return
    }
    if (command === '/analyze') {
      if (argText) bridge.analyze(argText.split(/\s+/)[0])
      return
    }
    if (command === '/reset' || command === '/new') {
      bridge.reset()
      return
    }
    if (command === '/resume') {
      openHistory()
      return
    }
    return
  }

  bridge.ask(text)
}

/** The research chat, as a side panel next to the dashboard/stock view,
 * driven by the main process's ChatSession (src/core/session.ts). */
export function ChatPanel({
  bridge,
  onClose,
  onOpenConsiderations,
  onOpenSettings
}: {
  bridge: Bridge
  onClose: () => void
  onOpenConsiderations: () => void
  onOpenSettings: () => void
}) {
  const { transcript, isBusy, status, reset, setThinking, conversations, listConversations, resume } = bridge
  const [draft, setDraft] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const openHistory = (): void => {
    listConversations()
    setHistoryOpen(true)
  }
  const closeHistory = useCallback(() => setHistoryOpen(false), [])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  // Follows new rows, and reasoning as it grows.
  const lastText = transcript.at(-1)?.kind === 'reasoning' ? (transcript.at(-1) as { text: string }).text.length : 0
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [transcript.length, lastText])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = (): void => {
    if (isBusy) return
    routeInput(draft, bridge, openHistory)
    setDraft('')
  }

  const needsSetup = status !== null && !status.providerKeyPresent
  const reasoningLive = transcript.some((item) => item.kind === 'reasoning' && item.endedAt === null && item.text !== '')

  return (
    <aside className="chat-panel">
      <header className="chat-header">
        <span className="chat-title">Research chat</span>
        <div className="chat-actions">
          {status && status.thinking !== null && (
            <button
              className="toggle"
              role="switch"
              aria-checked={status.thinking}
              onClick={() => setThinking(!status.thinking)}
              title="Thinking mode: deeper answers, but slower. Applies from the next question."
            >
              Thinking
              <span className="toggle-track" aria-hidden="true">
                <span className="toggle-knob" />
              </span>
            </button>
          )}
          <button onClick={reset} title="Start a new conversation">
            New
          </button>
          <div className="history">
            <button
              onClick={() => (historyOpen ? closeHistory() : openHistory())}
              disabled={isBusy}
              aria-expanded={historyOpen}
              title="Pick up a saved conversation"
            >
              History
            </button>
            {historyOpen && (
              <HistoryMenu
                conversations={conversations}
                onClose={closeHistory}
                onPick={(id) => {
                  closeHistory()
                  resume(id)
                }}
              />
            )}
          </div>
          <button onClick={onOpenConsiderations} title="Factors the agent always weighs">
            Considerations
          </button>
          <button className="icon-button" onClick={onClose} title="Close chat (⌘J)" aria-label="Close chat">
            ×
          </button>
        </div>
      </header>

      {needsSetup && (
        <div className="banner">
          <span>No API key for LLM provider "{status?.provider}".</span>
          <button onClick={onOpenSettings}>Settings</button>
        </div>
      )}

      <div className="transcript" ref={scrollRef}>
        {transcript.length === 0 && (
          <p className="chat-empty">
            Ask about a company or the market, or use <code>/price AAPL</code>, <code>/analyze NVDA</code>,{' '}
            <code>/reset</code>, <code>/resume</code>.
          </p>
        )}
        {transcript.map((item, index) => (
          <TranscriptRow key={`${item.id}-${index}`} item={item} />
        ))}
        {/* With thinking mode on, the live reasoning block already shows progress. */}
        {isBusy && !reasoningLive && <div className="chip chip-dim">thinking…</div>}
      </div>

      <form
        className="input-bar"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <textarea
          ref={inputRef}
          value={draft}
          disabled={isBusy}
          rows={2}
          placeholder="Ask a question…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !isComposing(e)) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button type="submit" disabled={isBusy}>
          {isBusy ? '…' : 'Send'}
        </button>
      </form>
    </aside>
  )
}
