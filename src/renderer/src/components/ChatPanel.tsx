import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationSummary, ViewContext } from '../../../shared/types'
import { isComposing } from '../keys'
import type { useBridge } from '../useBridge'
import { joinSpoken, useDictation } from '../voice/useDictation'
import { SERVER_LABELS, ServerDot } from '../voice/ServerDot'
import type { VoiceSetup } from '../voice/useVoiceSetup'
import { EnterIcon, WaveIcon } from './InputIcons'
import { TranscriptRow } from './TranscriptRow'

type Bridge = ReturnType<typeof useBridge>

/** How long Space must be held to start dictating. */
const SPACE_HOLD_MS = 500

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
function routeInput(
  raw: string,
  bridge: Bridge,
  openHistory: () => void,
  references: Map<string, ViewContext>
): void {
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

  // Only references still in the text count: deleting a token drops its data.
  const contexts = [...references.values()].filter((c) => text.includes(c.token))
  bridge.ask(text, contexts.length ? contexts : undefined)
}

/** The research chat, as a side panel next to the dashboard/stock view,
 * driven by the main process's ChatSession (src/core/session.ts). */
export function ChatPanel({
  bridge,
  voice,
  onClose,
  onOpenConsiderations,
  onOpenSettings,
  reference
}: {
  bridge: Bridge
  voice: VoiceSetup
  onClose: () => void
  onOpenConsiderations: () => void
  onOpenSettings: () => void
  /** A chart point to insert into the draft as a `[AAPL on 2026-09-12]` token;
   * `n` changes on every click so a repeat of the same point is seen. */
  reference: { n: number; context: ViewContext } | null
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

  // Data behind the tokens in the draft, sent along with the message.
  const references = useRef(new Map<string, ViewContext>())

  useEffect(() => {
    if (!reference) return
    const { token } = reference.context
    references.current.set(token, reference.context)
    setDraft((d) => (d.includes(token) ? d : `${d}${d && !/\s$/.test(d) ? ' ' : ''}${token} `))
    const input = inputRef.current
    if (input) {
      input.focus()
      // After React commits the new value, so the caret lands past the token.
      requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length))
    }
  }, [reference?.n]) // eslint-disable-line react-hooks/exhaustive-deps

  // Voice dictation. While it runs the textarea shows `base` + the words so
  // far (and is read-only); cancelling puts `base` back.
  const dictationBase = useRef('')
  const dictated = useRef('') // the full text as dictation last showed it
  const [polishing, setPolishing] = useState(false)
  const focusEnd = (): void => {
    const input = inputRef.current
    if (input) {
      input.focus()
      requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length))
    }
  }
  const dictation = useDictation(
    (text) => {
      dictated.current = text
      setDraft(text)
    },
    (cancelled) => {
      if (cancelled) setDraft(dictationBase.current)
      focusEnd()
      const base = dictationBase.current
      const spoken = dictated.current.startsWith(base) ? dictated.current.slice(base.length).trim() : ''
      if (cancelled || !voice.status?.polish || !spoken) return
      // The box is locked while the model cleans the transcript; on any
      // failure the raw text simply stays.
      setPolishing(true)
      window.stox
        .polishSpeech(spoken)
        .then((polished) => setDraft(joinSpoken(base, polished)))
        .catch(() => {})
        .finally(() => {
          setPolishing(false)
          focusEnd()
        })
    }
  )
  const dictating = dictation.state !== 'idle'
  const settingUp = voice.phase !== 'idle'
  const startDictation = (base = draft): void => {
    dictationBase.current = base
    void dictation.start(base)
  }
  // The mic button: dictate when voice is ready. Setting it up (downloading
  // the model) happens in Settings; a stopped engine is simply started.
  const onMicClick = (): void => {
    if (dictating) return void dictation.stop()
    if (settingUp || !voice.status?.available) return
    if (!voice.status.modelReady) onOpenSettings()
    else if (voice.status.server === 'stopped') void voice.prepare(true)
    else if (voice.ready) startDictation()
  }

  // Hold Space to talk, release to stop -- with or without text in the box.
  // A tap must still type its space, so the first Space goes in as usual; if
  // it is still down after SPACE_HOLD_MS the hold begins, that space is taken
  // back out, and any other key pressed meanwhile means it was typing.
  const spaceTimer = useRef<number | null>(null)
  const spaceHeld = useRef(false)
  const releaseSpace = (): void => {
    if (spaceTimer.current !== null) window.clearTimeout(spaceTimer.current)
    spaceTimer.current = null
    if (spaceHeld.current) {
      spaceHeld.current = false
      void dictation.stop()
    }
  }

  const submit = (): void => {
    if (isBusy || dictating || polishing) return
    routeInput(draft, bridge, openHistory, references.current)
    references.current.clear()
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

      {(voice.error || dictation.error) && (
        <div className="banner">
          <span>{voice.error ?? dictation.error}</span>
          {voice.error && <button onClick={onOpenSettings}>Settings</button>}
        </div>
      )}

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
          readOnly={dictating || polishing}
          rows={2}
          placeholder={dictating ? 'Listening…' : polishing ? 'Polishing…' : 'Ask a question…'}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={releaseSpace}
          onKeyUp={(e) => {
            if (e.code === 'Space') releaseSpace()
          }}
          onKeyDown={(e) => {
            if (isComposing(e)) return
            if (e.code !== 'Space' && spaceTimer.current !== null) {
              window.clearTimeout(spaceTimer.current)
              spaceTimer.current = null
            }
            if (e.key === 'Escape' && dictating) {
              e.preventDefault()
              spaceHeld.current = false
              dictation.cancel()
            } else if (e.code === 'Space' && !dictating && voice.ready && !isBusy && !e.metaKey && !e.ctrlKey && !e.altKey) {
              if (e.repeat) {
                e.preventDefault() // a held Space types nothing more
              } else if (spaceTimer.current === null) {
                const before = draft
                spaceTimer.current = window.setTimeout(() => {
                  spaceTimer.current = null
                  spaceHeld.current = true
                  setDraft(before) // take the first space back out
                  startDictation(before)
                }, SPACE_HOLD_MS)
              }
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button
          type="button"
          className={`mic-button${dictation.state === 'listening' ? ' listening' : ''}`}
          disabled={isBusy || polishing || !voice.status?.available || settingUp || dictation.state === 'finishing'}
          aria-pressed={dictation.state === 'listening'}
          aria-label={dictating ? 'Stop dictation' : 'Dictate'}
          title={
            !voice.status?.available
              ? 'Voice input is unavailable in this build'
              : settingUp
                ? 'Getting voice input ready…'
                : dictating
                  ? 'Stop (or release Space)'
                  : !voice.status.modelReady
                    ? 'Set up voice input in Settings'
                    : voice.ready
                      ? 'Dictate (or hold Space)'
                      : `Speech engine ${SERVER_LABELS[voice.status.server].toLowerCase()}; click to start it`
          }
          onClick={onMicClick}
        >
          {dictation.state === 'starting' || settingUp ? '…' : <WaveIcon live={dictation.state === 'listening'} />}
          {voice.status?.available && !dictating && <ServerDot state={voice.status.server} />}
        </button>
        <button type="submit" className="primary send-button" disabled={isBusy} title="Send (Enter)" aria-label="Send">
          {isBusy ? '…' : <EnterIcon />}
        </button>
      </form>
    </aside>
  )
}
