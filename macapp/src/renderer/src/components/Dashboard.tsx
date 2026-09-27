import { useEffect, useState } from 'react'
import { displaySymbol } from '../../../shared/symbols'
import type { Bar, Quote, WatchlistEntry } from '../../../shared/types'
import { changeClass, fmtChange, fmtCompact, fmtPrice, fmtSignedPercent } from '../format'
import { Sparkline } from './Sparkline'

function TickerCard({
  entry,
  quote,
  missing,
  onOpen,
  onUnpin
}: {
  entry: WatchlistEntry
  quote: Quote | undefined
  missing: boolean
  onOpen: () => void
  onUnpin: () => void
}) {
  const [bars, setBars] = useState<Bar[]>([])

  useEffect(() => {
    let cancelled = false
    window.stox
      .history(entry.code, '1M')
      .then((b) => !cancelled && setBars(b))
      .catch(() => undefined) // the sparkline is decoration; the card still shows the quote
    return () => {
      cancelled = true
    }
  }, [entry.code])

  return (
    <div
      className="ticker-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen()
      }}
    >
      <div className="ticker-card-head">
        <div className="ticker-card-id">
          <span className="ticker-symbol">{displaySymbol(entry.code)}</span>
          <span className="ticker-name">{entry.name}</span>
        </div>
        <button
          className="icon-button unpin"
          title="Unpin"
          aria-label={`Unpin ${displaySymbol(entry.code)}`}
          onClick={(e) => {
            e.stopPropagation()
            onUnpin()
          }}
        >
          ×
        </button>
      </div>

      {quote ? (
        <div className="ticker-card-body">
          <div>
            <div className="ticker-price">{fmtPrice(quote.price)}</div>
            <div className={`ticker-change ${changeClass(quote.change)}`}>
              {fmtChange(quote.change, quote.price)} ({fmtSignedPercent(quote.percent)})
            </div>
          </div>
          <div title="Last month">
            <Sparkline bars={bars} />
          </div>
        </div>
      ) : (
        <div className="ticker-card-body dim">{missing ? 'No quote data' : 'Loading…'}</div>
      )}

      {quote && (
        <div className="ticker-card-foot">
          <span>
            Day {fmtPrice(quote.low)} – {fmtPrice(quote.high)}
          </span>
          <span>Vol {fmtCompact(quote.volume)}</span>
        </div>
      )}
    </div>
  )
}

export function Dashboard({
  watchlist,
  quotes,
  missing,
  onOpen,
  onUnpin,
  onFocusSearch
}: {
  watchlist: WatchlistEntry[]
  quotes: Record<string, Quote>
  missing: Set<string>
  onOpen: (entry: WatchlistEntry) => void
  onUnpin: (code: string) => void
  onFocusSearch: () => void
}) {
  if (watchlist.length === 0) {
    return (
      <div className="empty-state">
        <h2>Your dashboard is empty</h2>
        <p>Search for a stock, open it, and pin it to keep an eye on it here.</p>
        <button onClick={onFocusSearch}>Search for a stock</button>
      </div>
    )
  }

  return (
    <div className="dashboard">
      {watchlist.map((entry) => (
        <TickerCard
          key={entry.code}
          entry={entry}
          quote={quotes[entry.code]}
          missing={missing.has(entry.code)}
          onOpen={() => onOpen(entry)}
          onUnpin={() => onUnpin(entry.code)}
        />
      ))}
    </div>
  )
}
