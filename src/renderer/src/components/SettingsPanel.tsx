import { useEffect, useState } from 'react'
import { THEMES, VOICE_LANGUAGES, type Theme, type VoiceLanguage } from '../../../shared/types'
import { SERVER_LABELS, ServerDot } from '../voice/ServerDot'
import type { VoiceSetup } from '../voice/useVoiceSetup'

const PROVIDERS = ['deepseek', 'openai'] as const

const THEME_LABELS: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' }

const CHAT_FIELDS = [
  { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek API key' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI API key' }
] as const

/** Voice dictation: the speech model and the engine (Gemma on llama.cpp) that runs it. */
function VoiceSection({ voice }: { voice: VoiceSetup }) {
  const { status, phase, progress, error } = voice
  if (!status) return null
  const busy = phase !== 'idle'
  return (
    <>
      <h3 className="settings-section">Voice dictation</h3>
      <p className="panel-sheet-hint">
        Speech is transcribed on this Mac with Gemma; the audio never leaves it. Hold Space in the
        chat input, or click its wave button, to dictate.
      </p>
      {!status.available ? (
        <p className="panel-sheet-hint">Voice input isn't available: this build has no speech engine.</p>
      ) : (
        <>
          <div className="voice-row">
            <span>Speech model</span>
            {phase === 'downloading' ? (
              <span className="voice-progress">
                <progress value={progress} max={1} />
                {Math.round(progress * 100)}%
              </span>
            ) : status.modelReady ? (
              <span className="voice-value">Downloaded (about 3.4 GB)</span>
            ) : (
              <button type="button" className="primary" disabled={busy} onClick={() => void voice.prepare(false)}>
                Download (about 3.4 GB)
              </button>
            )}
          </div>
          <div className="voice-row">
            <span>Speech engine</span>
            <span className="voice-value">
              <ServerDot state={status.server} /> {SERVER_LABELS[status.server]}
              {status.server === 'running' ? (
                <button type="button" onClick={() => void voice.stopServer()}>
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy || status.server === 'starting' || !status.modelReady}
                  title={status.modelReady ? undefined : 'Download the speech model first'}
                  onClick={() => void voice.prepare(true)}
                >
                  Start
                </button>
              )}
            </span>
          </div>
          <label className="voice-row">
            <span>Spoken language</span>
            <select
              value={status.language}
              onChange={(e) => void voice.setLanguage(e.target.value as VoiceLanguage)}
            >
              {VOICE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <p className="panel-sheet-hint">
            Pin the language you dictate in: auto-detection can guess wrong on a short phrase. Applies
            from the next phrase.
          </p>
          <p className="panel-sheet-hint">
            The engine starts when you open the chat and stops after 10 minutes without dictation.
          </p>
          {error && <p className="voice-error">{error}</p>}
        </>
      )}
    </>
  )
}

export function SettingsPanel({
  voice,
  onClose,
  onSaved
}: {
  voice: VoiceSetup
  onClose: () => void
  onSaved: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState(false)
  const [theme, setTheme] = useState<Theme | null>(null)

  useEffect(() => {
    window.stox.getTheme().then(setTheme)
    window.stox.readSettings().then((current) => {
      setValues(current)
      setLoaded(true)
    })
  }, [])

  // Takes effect immediately (and is saved on its own), independent of the form's Save.
  const chooseTheme = (next: Theme) => {
    setTheme(next)
    void window.stox.setTheme(next)
  }

  const setField = (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value }))

  return (
    <div className="panel-overlay">
      <div className="panel-sheet">
        <div className="panel-sheet-header">
          <h2>Settings</h2>
          <button onClick={onClose}>Close</button>
        </div>
        {theme && (
          <div className="settings-row">
            <span>Appearance</span>
            <div className="segmented theme-picker" role="radiogroup" aria-label="Appearance">
              {THEMES.map((t) => (
                <button
                  key={t}
                  role="radio"
                  aria-checked={t === theme}
                  className={t === theme ? 'active' : ''}
                  onClick={() => chooseTheme(t)}
                >
                  {THEME_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
        )}
        <VoiceSection voice={voice} />
        <h3 className="settings-section">API keys</h3>
        <p className="panel-sheet-hint">
          Saved to ~/.config/stox/.env — the same file the terminal CLI reads, so a key set here
          works there too.
        </p>
        {loaded && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void window.stox.saveSettings(values).then(() => {
                onSaved()
                onClose()
              })
            }}
          >
            <label className="settings-row">
              <span>EODHD API key (prices, history and search)</span>
              <input
                type="password"
                value={values.EODHD_API_KEY ?? ''}
                onChange={(e) => setField('EODHD_API_KEY', e.target.value)}
              />
            </label>
            <p className="panel-sheet-hint">Fundamentals come from Yahoo Finance and need no key.</p>

            <h3 className="settings-section">Research chat</h3>
            <label className="settings-row">
              <span>LLM provider</span>
              <select
                value={values.STOX_LLM_PROVIDER ?? 'deepseek'}
                onChange={(e) => setField('STOX_LLM_PROVIDER', e.target.value)}
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-row">
              <span>Model override (optional)</span>
              <input
                value={values.STOX_LLM_MODEL ?? ''}
                onChange={(e) => setField('STOX_LLM_MODEL', e.target.value)}
                placeholder="leave blank for the provider default"
              />
            </label>
            {CHAT_FIELDS.map(({ key, label }) => (
              <label className="settings-row" key={key}>
                <span>{label}</span>
                <input
                  type="password"
                  value={values[key] ?? ''}
                  onChange={(e) => setField(key, e.target.value)}
                />
              </label>
            ))}

            <button type="submit" className="primary">Save</button>
          </form>
        )}
      </div>
    </div>
  )
}
