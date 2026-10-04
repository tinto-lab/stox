import { useEffect, useRef, useState } from 'react'
import type { useBridge } from '../useBridge'
import { TranscriptRow } from './TranscriptRow'

type Bridge = ReturnType<typeof useBridge>

/** Mirrors the terminal CLI's routing (src/cli/shell.ts): a
 * slash-prefixed line is a command, everything else (including a bare
 * ticker) goes to the agent -- there's no local ticker-detection heuristic
 * on either side. */
function routeInput(raw: string, bridge: Bridge): void {
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
  const { transcript, isBusy, status, reset, setThinking } = bridge
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [transcript.length])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = (): void => {
    if (isBusy) return
    routeInput(draft, bridge)
    setDraft('')
  }

  const needsSetup = status !== null && !status.providerKeyPresent

  return (
    <aside className="chat-panel">
      <header className="chat-header">
        <span className="chat-title">Research chat</span>
        <div className="chat-actions">
          {status && status.thinking !== null && (
            <button
              className={status.thinking ? 'primary' : ''}
              onClick={() => setThinking(!status.thinking)}
              aria-pressed={status.thinking}
              title="Thinking mode: deeper answers, but slower. Applies from the next question."
            >
              Thinking {status.thinking ? 'on' : 'off'}
            </button>
          )}
          <button onClick={reset} title="Start a new conversation">
            New
          </button>
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
            <code>/reset</code>.
          </p>
        )}
        {transcript.map((item, index) => (
          <TranscriptRow key={`${item.id}-${index}`} item={item} />
        ))}
        {isBusy && <div className="chip chip-dim">thinking…</div>}
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
            if (e.key === 'Enter' && !e.shiftKey) {
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
