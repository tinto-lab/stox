import type { AlertDirection, MonitorsState } from '../../../shared/types'
import { fmtTime } from '../format'

const ARROWS: Record<AlertDirection, string> = { rise: '▲', drop: '▼', watch: '●' }
const DIRECTION_CLASS: Record<AlertDirection, string> = { rise: 'up', drop: 'down', watch: '' }

export function AlertsPanel({
  state,
  onRemove,
  onOpenSettings,
  onClose
}: {
  state: MonitorsState | null
  onRemove: (id: string) => void
  onOpenSettings: () => void
  onClose: () => void
}) {
  return (
    <div className="panel-overlay">
      <div className="panel-sheet alerts-sheet">
        <div className="panel-sheet-header">
          <h2>News alerts</h2>
          <button onClick={onClose}>Close</button>
        </div>
        <p className="panel-sheet-hint">
          Ask the chat things like “alert me when crude oil or tanker rates may rise”. It picks the
          news to watch (e.g. Iran, OPEC, Strait of Hormuz), checks it every few minutes while Stox is
          open, and messages you on WhatsApp when something moves your stocks.
        </p>

        {state && !state.whatsappConfigured && (
          <div className="banner alerts-banner">
            <span>WhatsApp isn’t set up, so alerts only show here.</span>
            <button onClick={onOpenSettings}>Open Settings</button>
          </div>
        )}
        {state?.lastError && <div className="banner alerts-banner">{state.lastError}</div>}

        <h3 className="settings-section">Monitors</h3>
        {state && state.monitors.length > 0 && (
          <p className="panel-sheet-hint">
            {state.lastCheckAt ? `Last checked ${fmtTime(state.lastCheckAt)}` : 'First check running…'}
          </p>
        )}
        <ul className="considerations-list">
          {state?.monitors.map((m) => (
            <li key={m.id} className="monitor-item">
              <div className="monitor-body">
                <div>{m.goal}</div>
                <div className="monitor-chips">
                  {m.tickers.map((t) => (
                    <span key={t} className="badge">
                      {t}
                    </span>
                  ))}
                  {m.queries.map((q) => (
                    <span key={q} className="chip">
                      {q}
                    </span>
                  ))}
                </div>
              </div>
              <button onClick={() => onRemove(m.id)}>Remove</button>
            </li>
          ))}
          {state?.monitors.length === 0 && <li className="empty">No monitors yet</li>}
        </ul>

        <h3 className="settings-section">Recent alerts</h3>
        <ul className="considerations-list">
          {state?.alerts.map((a) => (
            <li key={a.id} className="alert-item">
              <div className="alert-head">
                <span className={DIRECTION_CLASS[a.direction]}>{ARROWS[a.direction]}</span>
                <strong>{a.title}</strong>
              </div>
              {a.impacts.length > 0 && (
                <div className="monitor-chips">
                  {a.impacts.map((i) => (
                    <span key={i.ticker} className={`badge ${DIRECTION_CLASS[i.direction]}`}>
                      {i.ticker} {ARROWS[i.direction]}
                    </span>
                  ))}
                </div>
              )}
              {a.reason && <div>{a.reason}</div>}
              {a.articles.map((article) => (
                <a key={article.link} href={article.link} target="_blank" rel="noreferrer">
                  {article.title}
                </a>
              ))}
              <div className="panel-sheet-hint">
                {fmtTime(a.created_at)} · {a.goal}
                {a.delivered ? ' · sent to WhatsApp' : ` · not sent: ${a.delivery_error ?? 'unknown error'}`}
              </div>
            </li>
          ))}
          {state?.alerts.length === 0 && <li className="empty">No alerts yet</li>}
        </ul>
      </div>
    </div>
  )
}
