import { forwardRef, useEffect, useState } from 'react'
import { displaySymbol, normalize } from '../../../shared/symbols'
import type { SymbolMatch, WatchlistEntry } from '../../../shared/types'
import { isComposing } from '../keys'

/** Ticker/company lookup. Typing searches EODHD's symbol index (debounced);
 * Enter opens the highlighted match, or the typed text as a ticker when
 * nothing is highlighted -- so `AAPL` + Enter works without waiting. */
export const SearchBox = forwardRef<HTMLInputElement, { onOpen: (entry: WatchlistEntry) => void }>(
  function SearchBox({ onOpen }, ref) {
    const [query, setQuery] = useState('')
    const [matches, setMatches] = useState<SymbolMatch[]>([])
    const [highlight, setHighlight] = useState(-1)
    const [open, setOpen] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
      const q = query.trim()
      if (q.length < 1) {
        setMatches([])
        setError(null)
        return
      }
      let cancelled = false
      const timer = setTimeout(() => {
        window.stox
          .search(q)
          .then((results) => {
            if (cancelled) return
            setMatches(results)
            setError(null)
            setHighlight(-1)
          })
          .catch((e: Error) => {
            if (!cancelled) setError(e.message)
          })
      }, 250)
      return () => {
        cancelled = true
        clearTimeout(timer)
      }
    }, [query])

    const choose = (entry: WatchlistEntry): void => {
      onOpen(entry)
      setQuery('')
      setMatches([])
      setOpen(false)
    }

    const submit = (): void => {
      if (highlight >= 0 && matches[highlight]) {
        const m = matches[highlight]
        choose({ code: m.code, name: m.name })
      } else if (query.trim()) {
        const code = normalize(query)
        const exact = matches.find((m) => m.code === code)
        choose({ code, name: exact?.name ?? '' })
      }
    }

    const showDropdown = open && query.trim().length > 0 && (matches.length > 0 || error !== null)

    return (
      <div className="search">
        <input
          ref={ref}
          value={query}
          placeholder="Search ticker or company  ⌘K"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (isComposing(e)) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setHighlight((h) => Math.min(h + 1, matches.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setHighlight((h) => Math.max(h - 1, -1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              setQuery('')
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
        {showDropdown && (
          <ul className="search-results" role="listbox">
            {error && <li className="search-error">{error}</li>}
            {matches.map((m, i) => (
              <li
                key={m.code}
                role="option"
                aria-selected={i === highlight}
                className={i === highlight ? 'active' : ''}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose({ code: m.code, name: m.name })
                }}
              >
                <span className="search-symbol">{displaySymbol(m.code)}</span>
                <span className="search-name">{m.name}</span>
                <span className="search-meta">
                  {m.exchange} · {m.type}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }
)
