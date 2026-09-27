import { useRef, useState } from 'react'
import { ConsiderationsPanel } from './components/ConsiderationsPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { TranscriptRow } from './components/TranscriptRow'
import { useBridge } from './useBridge'

/** Mirrors stoxlib/shell.py's handle_command/handle_query routing: a
 * slash-prefixed line is a command, everything else (including a bare
 * ticker) goes to the agent -- there's no local ticker-detection heuristic
 * on either side. */
function routeInput(
  raw: string,
  actions: { ask: (t: string) => void; quote: (t: string[]) => void; analyze: (t: string) => void; reset: () => void }
): void {
  const text = raw.trim()
  if (!text) return

  if (text.startsWith('/')) {
    const [word, ...rest] = text.split(/\s+/)
    const command = word.toLowerCase()
    const argText = rest.join(' ').trim()

    if (command === '/price') {
      if (argText) actions.quote(argText.split(/\s+/))
      return
    }
    if (command === '/analyze') {
      if (argText) actions.analyze(argText.split(/\s+/)[0])
      return
    }
    if (command === '/reset' || command === '/new') {
      actions.reset()
      return
    }
    return
  }

  actions.ask(text)
}

export default function App() {
  const { transcript, isBusy, considerations, status, ask, quote, analyze, reset, addConsideration, removeConsideration, refreshStatus } =
    useBridge()
  const [draft, setDraft] = useState('')
  const [showConsiderations, setShowConsiderations] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const submit = (): void => {
    if (isBusy) return
    routeInput(draft, { ask, quote, analyze, reset })
    setDraft('')
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }))
  }

  const needsSetup = status !== null && (!status.eodhd_key || !status.provider_key_present)

  return (
    <div className="app">
      <header className="toolbar">
        <span className="app-title">stox</span>
        <div className="toolbar-actions">
          <button onClick={reset}>New chat</button>
          <button onClick={() => setShowConsiderations(true)}>Considerations</button>
          <button onClick={() => setShowSettings(true)}>Settings</button>
        </div>
      </header>

      {needsSetup && (
        <div className="banner">
          {!status?.eodhd_key && <span>No EODHD API key set. </span>}
          {!status?.provider_key_present && <span>No API key for provider "{status?.provider}". </span>}
          <button onClick={() => setShowSettings(true)}>Open Settings</button>
        </div>
      )}

      <div className="transcript" ref={scrollRef}>
        {transcript.map((item, index) => (
          <TranscriptRow key={`${item.id}-${index}`} item={item} />
        ))}
      </div>

      <form
        className="input-bar"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <textarea
          value={draft}
          disabled={isBusy}
          placeholder="Ask a question, type a ticker, or /price, /analyze, /reset..."
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

      {showConsiderations && (
        <ConsiderationsPanel
          considerations={considerations}
          onAdd={addConsideration}
          onRemove={removeConsideration}
          onClose={() => setShowConsiderations(false)}
        />
      )}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} onSaved={refreshStatus} />}
    </div>
  )
}
