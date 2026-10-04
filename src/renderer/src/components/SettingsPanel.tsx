import { useEffect, useState } from 'react'
import { THEMES, type Theme } from '../../../shared/types'

const PROVIDERS = ['deepseek', 'openai'] as const

const THEME_LABELS: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' }

const CHAT_FIELDS = [
  { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek API key' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI API key' }
] as const

export function SettingsPanel({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
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
        <h3 className="settings-section">API keys</h3>
        <p className="panel-sheet-hint">
          Saved to ~/.config/stox/.env — the same file the terminal CLI reads, so a key set here is
          also picked up by `./stox`.
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
