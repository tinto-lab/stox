import { useEffect, useState } from 'react'

const PROVIDERS = ['anthropic', 'deepseek', 'openai'] as const

const FIELDS = [
  { key: 'EODHD_API_KEY', label: 'EODHD API key (quotes, news, history, fundamentals)' },
  { key: 'WEBZ_API_KEY', label: 'webz.io API key (geopolitical news, optional)' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key' },
  { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek API key' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI API key' }
] as const

export function SettingsPanel({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    window.stox.readSettings().then((current) => {
      setValues(current)
      setLoaded(true)
    })
  }, [])

  const setField = (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value }))

  return (
    <div className="panel-overlay">
      <div className="panel-sheet">
        <div className="panel-sheet-header">
          <h2>Settings</h2>
          <button onClick={onClose}>close</button>
        </div>
        <p className="panel-sheet-hint">
          Saved to ~/.config/stox/.env — the same file the terminal CLI reads, so a key set here is
          also picked up by `python stox.py`.
        </p>
        {loaded && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              window.stox.saveSettings(values).then(() => {
                onSaved()
                onClose()
              })
            }}
          >
            <label className="settings-row">
              <span>LLM provider</span>
              <select
                value={values.STOX_LLM_PROVIDER ?? 'anthropic'}
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
            {FIELDS.map(({ key, label }) => (
              <label className="settings-row" key={key}>
                <span>{label}</span>
                <input
                  type="password"
                  value={values[key] ?? ''}
                  onChange={(e) => setField(key, e.target.value)}
                />
              </label>
            ))}
            <button type="submit">save &amp; restart backend</button>
          </form>
        )}
      </div>
    </div>
  )
}
