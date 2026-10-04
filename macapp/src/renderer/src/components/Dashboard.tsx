import { useEffect, useMemo, useRef, useState } from 'react'
import { quoteDate, withLiveBar } from '../../../shared/liveBar'
import { displaySymbol } from '../../../shared/symbols'
import type { Bar, Quote, WatchlistEntry } from '../../../shared/types'
import { changeClass, fmtChange, fmtCompact, fmtPrice, fmtSignedPercent } from '../format'
import { Sparkline } from './Sparkline'

const NUDGE_KEYS: Record<string, 'left' | 'right' | 'up' | 'down'> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down'
}

function TickerCard({
  entry,
  quote,
  missing,
  refreshing,
  dragging,
  onOpen,
  onUnpin,
  onDragStart,
  onDragOver,
  onDragEnd,
  onNudge
}: {
  entry: WatchlistEntry
  quote: Quote | undefined
  missing: boolean
  /** A quote refresh is in flight -- the sparkline dims until the new price lands. */
  refreshing: boolean
  dragging: boolean
  onOpen: () => void
  onUnpin: () => void
  onDragStart: () => void
  onDragOver: () => void
  onDragEnd: () => void
  onNudge: (direction: 'left' | 'right' | 'up' | 'down') => void
}) {
  const [bars, setBars] = useState<Bar[]>([])
  const tradingDay = quoteDate(quote)

  // Fetched again when the quote moves to a new trading day, so a window left
  // open overnight picks up the bar for the day that just closed.
  useEffect(() => {
    let cancelled = false
    window.stox
      .history(entry.code, '1M')
      .then((b) => !cancelled && setBars(b))
      .catch(() => undefined) // the sparkline is decoration; the card still shows the quote
    return () => {
      cancelled = true
    }
  }, [entry.code, tradingDay])
  // Between fetches, the live quote moves the end point on every refresh.
  const liveBars = useMemo(() => withLiveBar(bars, quote, '1M'), [bars, quote])

  return (
    <div
      className={`ticker-card${dragging ? ' dragging' : ''}`}
      data-code={entry.code}
      role="button"
      tabIndex={0}
      title="Drag, or ⌥ + arrow keys, to reorder"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', entry.code)
        onDragStart()
      }}
      onDragOver={(e) => {
        e.preventDefault()
        onDragOver()
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen()
        const direction = NUDGE_KEYS[e.key]
        if (direction && e.altKey) {
          e.preventDefault()
          onNudge(direction)
        }
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
          <div className={`sparkline-wrap${refreshing ? ' refreshing' : ''}`} title="Last month" aria-busy={refreshing}>
            <Sparkline bars={liveBars} />
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

/** `list` with the entry `code` taken out and put back at `index`. */
function moveTo(list: WatchlistEntry[], code: string, index: number): WatchlistEntry[] {
  const from = list.findIndex((e) => e.code === code)
  if (from < 0 || from === index) return list
  const next = list.filter((e) => e.code !== code)
  next.splice(index, 0, list[from])
  return next
}

export function Dashboard({
  watchlist,
  quotes,
  missing,
  refreshing,
  onOpen,
  onUnpin,
  onRearrange,
  onFocusSearch
}: {
  watchlist: WatchlistEntry[]
  quotes: Record<string, Quote>
  missing: Set<string>
  refreshing: boolean
  onOpen: (entry: WatchlistEntry) => void
  onUnpin: (code: string) => void
  onRearrange: (next: WatchlistEntry[]) => void
  onFocusSearch: () => void
}) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [dragged, setDragged] = useState<string | null>(null)
  // The order while a drag is in progress: the dragged card inserted where the
  // pointer is and the others shifted around it, saved only on drop (Esc reverts).
  const [preview, setPreview] = useState<WatchlistEntry[] | null>(null)
  const [refocus, setRefocus] = useState<string | null>(null)
  const shown = preview ?? watchlist

  // Moving cards in the DOM can drop keyboard focus from the one being moved.
  useEffect(() => {
    if (!refocus) return
    gridRef.current?.querySelector<HTMLElement>(`[data-code="${CSS.escape(refocus)}"]`)?.focus()
    setRefocus(null)
  }, [refocus, watchlist])

  /** Inserts the dragged card at `target`'s place in the current preview.
   * Functional update keyed by code: several dragover events can fire between
   * renders, and each must build on the previous one's order. */
  const dragOnto = (target: string | 'end'): void => {
    if (!dragged || target === dragged) return
    setPreview((prev) => {
      const current = prev ?? watchlist
      const index = target === 'end' ? current.length - 1 : current.findIndex((e) => e.code === target)
      return index < 0 ? current : moveTo(current, dragged, index)
    })
  }

  const endDrag = (): void => {
    setDragged(null)
    setPreview(null)
  }

  /** ⌥-arrows: left/right step one place, up/down one row (however many
   * columns the window fits right now). */
  const nudge = (code: string, direction: 'left' | 'right' | 'up' | 'down'): void => {
    const cols = gridRef.current
      ? getComputedStyle(gridRef.current).gridTemplateColumns.split(' ').length
      : 1
    const step = { left: -1, right: 1, up: -cols, down: cols }[direction]
    const from = watchlist.findIndex((e) => e.code === code)
    const to = Math.min(watchlist.length - 1, Math.max(0, from + step))
    if (to === from) return
    onRearrange(moveTo(watchlist, code, to))
    setRefocus(code)
  }

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
    <div
      ref={gridRef}
      className="dashboard"
      onDragOver={(e) => {
        if (!dragged) return
        e.preventDefault()
        // Over the empty space after the last card: move to the end.
        const last = e.currentTarget.lastElementChild?.getBoundingClientRect()
        if (
          e.target === e.currentTarget &&
          last &&
          (e.clientY > last.bottom || (e.clientY >= last.top && e.clientX > last.right))
        ) {
          dragOnto('end')
        }
      }}
      onDrop={(e) => {
        e.preventDefault()
        if (preview) onRearrange(preview)
        endDrag()
      }}
    >
      {shown.map((entry) => (
        <TickerCard
          key={entry.code}
          entry={entry}
          quote={quotes[entry.code]}
          missing={missing.has(entry.code)}
          refreshing={refreshing}
          dragging={dragged === entry.code}
          onOpen={() => onOpen(entry)}
          onUnpin={() => onUnpin(entry.code)}
          onDragStart={() => setDragged(entry.code)}
          onDragOver={() => dragOnto(entry.code)}
          onDragEnd={endDrag}
          onNudge={(direction) => nudge(entry.code, direction)}
        />
      ))}
    </div>
  )
}
