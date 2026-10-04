import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MonitorsState, Quote, WatchlistEntry } from '../../shared/types'
import { AlertsPanel } from './components/AlertsPanel'
import { ChatPanel } from './components/ChatPanel'
import { ConsiderationsPanel } from './components/ConsiderationsPanel'
import { Dashboard } from './components/Dashboard'
import { ResizeHandle } from './components/ResizeHandle'
import { SearchBox } from './components/SearchBox'
import { SettingsPanel } from './components/SettingsPanel'
import { StockDetail } from './components/StockDetail'
import { fmtTime } from './format'
import { useBridge } from './useBridge'

const REFRESH_MS = 60_000

const CHAT_WIDTH_KEY = 'stox.chatWidth'
const CHAT_DEFAULT_WIDTH = 440
const CHAT_MIN_WIDTH = 320
// Room the dashboard/stock view always keeps; also enforced in CSS
// (.chat-slot's max-width) for when the window shrinks after a resize.
const MAIN_MIN_WIDTH = 420

// When the user last opened the Alerts panel, so the toolbar can count newer alerts.
const ALERTS_SEEN_KEY = 'stox.alertsSeenAt'

function loadAlertsSeenAt(): number {
  try {
    return Number(localStorage.getItem(ALERTS_SEEN_KEY)) || 0
  } catch {
    return 0
  }
}

function saveAlertsSeenAt(unixSeconds: number): void {
  try {
    localStorage.setItem(ALERTS_SEEN_KEY, String(unixSeconds))
  } catch {
    // storage unavailable -- the unread count just resets next launch
  }
}

function clampChatWidth(width: number): number {
  return Math.round(Math.max(CHAT_MIN_WIDTH, Math.min(width, window.innerWidth - MAIN_MIN_WIDTH)))
}

// localStorage: a per-machine view preference, fine to lose (see the catch blocks).
function loadChatWidth(): number {
  try {
    const saved = Number(localStorage.getItem(CHAT_WIDTH_KEY))
    return saved >= CHAT_MIN_WIDTH ? saved : CHAT_DEFAULT_WIDTH
  } catch {
    return CHAT_DEFAULT_WIDTH
  }
}

function saveChatWidth(width: number): void {
  try {
    localStorage.setItem(CHAT_WIDTH_KEY, String(width))
  } catch {
    // storage unavailable -- the width just won't be remembered
  }
}

export default function App() {
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([])
  const [selected, setSelected] = useState<WatchlistEntry | null>(null)
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [missing, setMissing] = useState<Set<string>>(new Set())
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  // A count, not a boolean: a manual refresh can overlap the timer's, and the
  // spinner should stay up until both have finished.
  const [refreshesInFlight, setRefreshesInFlight] = useState(0)
  const [hasEodhdKey, setHasEodhdKey] = useState(true)
  const [watchlistError, setWatchlistError] = useState<string | null>(null)

  // The chat panel stays mounted (just hidden) once opened, so closing it
  // doesn't lose the conversation; until then the chat is never touched.
  const [chatOpen, setChatOpen] = useState(false)
  const [chatStarted, setChatStarted] = useState(false)
  const [chatWidth, setChatWidth] = useState(loadChatWidth)
  const bridge = useBridge(chatStarted)

  const [showSettings, setShowSettings] = useState(false)
  const [showConsiderations, setShowConsiderations] = useState(false)
  const [showAlerts, setShowAlerts] = useState(false)
  const [monitorsState, setMonitorsState] = useState<MonitorsState | null>(null)
  const [alertsSeenAt, setAlertsSeenAt] = useState(loadAlertsSeenAt)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const openChat = useCallback(() => {
    setChatStarted(true)
    setChatOpen(true)
  }, [])

  const refreshStatus = useCallback(() => {
    window.stox
      .status()
      .then((s) => setHasEodhdKey(s.hasEodhdKey))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refreshStatus()
    window.stox
      .readWatchlist()
      .then(setWatchlist)
      .catch((e: Error) => setWatchlistError(`Couldn't load pinned stocks: ${e.message}`))
  }, [refreshStatus])

  useEffect(() => {
    const refresh = (): void => {
      window.stox.readMonitors().then(setMonitorsState).catch(() => undefined)
    }
    refresh()
    return window.stox.onMonitorsChanged(refresh)
  }, [])

  const unreadAlerts = monitorsState?.alerts.filter((a) => a.created_at > alertsSeenAt).length ?? 0

  // On open and again on close, so alerts that arrive while it's open count as seen.
  const markAlertsSeen = (): void => {
    const now = Date.now() / 1000
    setAlertsSeenAt(now)
    saveAlertsSeenAt(now)
  }

  const openAlerts = (): void => {
    markAlertsSeen()
    setShowAlerts(true)
  }

  // Quote every pinned ticker plus whatever's open, in one batched request, every minute.
  const codes = useMemo(() => {
    const set = new Set(watchlist.map((e) => e.code))
    if (selected) set.add(selected.code)
    return [...set]
  }, [watchlist, selected])
  const codesKey = codes.join(',')

  const refreshQuotes = useCallback(() => {
    if (!codes.length) return
    setRefreshesInFlight((n) => n + 1)
    window.stox
      .quotes(codes)
      .then(({ quotes: fresh, missing: absent }) => {
        setQuotes((prev) => {
          const next = { ...prev }
          for (const q of fresh) next[q.code] = q
          return next
        })
        setMissing(new Set(absent))
        setQuoteError(null)
        setUpdatedAt(Date.now() / 1000)
      })
      .catch((e: Error) => setQuoteError(e.message))
      .finally(() => setRefreshesInFlight((n) => n - 1))
    // codesKey, not codes: a new array with the same tickers shouldn't restart the timer.
  }, [codesKey])

  useEffect(() => {
    refreshQuotes()
    const timer = setInterval(refreshQuotes, REFRESH_MS)
    return () => clearInterval(timer)
  }, [refreshQuotes])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey) return
      if (e.key === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'j') {
        e.preventDefault()
        if (chatOpen) setChatOpen(false)
        else openChat()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chatOpen, openChat])

  const saveWatchlist = (next: WatchlistEntry[]): void => {
    setWatchlist(next)
    window.stox
      .writeWatchlist(next)
      .then(() => setWatchlistError(null))
      .catch((e: Error) => setWatchlistError(`Couldn't save pinned stocks: ${e.message}`))
  }

  const togglePin = (entry: WatchlistEntry): void => {
    if (watchlist.some((e) => e.code === entry.code)) {
      saveWatchlist(watchlist.filter((e) => e.code !== entry.code))
    } else {
      saveWatchlist([...watchlist, entry])
    }
  }

  const resizeChat = (width: number, done: boolean): void => {
    const clamped = clampChatWidth(width)
    setChatWidth(clamped)
    if (done) saveChatWidth(clamped)
  }

  const analyzeInChat = (code: string): void => {
    openChat()
    bridge.analyze(code)
  }

  return (
    <div className="app">
      <header className="toolbar">
        <button className="app-title" onClick={() => setSelected(null)} title="Dashboard">
          stox
        </button>
        <SearchBox ref={searchRef} onOpen={setSelected} />
        <div className="toolbar-actions">
          {updatedAt && <span className="updated">Updated {fmtTime(updatedAt)}</span>}
          <button
            className="refresh-button"
            onClick={refreshQuotes}
            disabled={refreshesInFlight > 0}
            title="Refresh prices"
            aria-busy={refreshesInFlight > 0}
          >
            {refreshesInFlight > 0 && <span className="spinner" aria-hidden />}
            {refreshesInFlight > 0 ? 'Refreshing…' : 'Refresh'}
          </button>
          <button onClick={openAlerts} title="News monitors and alerts">
            Alerts
            {unreadAlerts > 0 && <span className="toolbar-count">{unreadAlerts}</span>}
          </button>
          <button onClick={() => setShowSettings(true)}>Settings</button>
          <button
            className={chatOpen ? 'primary' : ''}
            onClick={() => (chatOpen ? setChatOpen(false) : openChat())}
            title="Toggle research chat (⌘J)"
          >
            Chat
          </button>
        </div>
      </header>

      {!hasEodhdKey ? (
        <div className="banner">
          <span>No EODHD API key set, so prices can't load.</span>
          <button onClick={() => setShowSettings(true)}>Open Settings</button>
        </div>
      ) : (
        quoteError && <div className="banner">{quoteError}</div>
      )}
      {watchlistError && <div className="banner">{watchlistError}</div>}

      <div className="workspace">
        <main className="main-pane">
          {selected ? (
            <StockDetail
              key={selected.code}
              entry={selected}
              quote={quotes[selected.code]}
              quoteMissing={missing.has(selected.code)}
              refreshing={refreshesInFlight > 0}
              pinned={watchlist.some((e) => e.code === selected.code)}
              onBack={() => setSelected(null)}
              onTogglePin={(name) => togglePin({ code: selected.code, name })}
              onAnalyze={() => analyzeInChat(selected.code)}
            />
          ) : (
            <Dashboard
              watchlist={watchlist}
              quotes={quotes}
              missing={missing}
              onOpen={setSelected}
              onUnpin={(code) => saveWatchlist(watchlist.filter((e) => e.code !== code))}
              onRearrange={saveWatchlist}
              onFocusSearch={() => searchRef.current?.focus()}
            />
          )}
        </main>

        {chatStarted && (
          <div className="chat-slot" hidden={!chatOpen} style={{ width: chatWidth }}>
            <ResizeHandle
              width={chatWidth}
              label="Resize chat panel"
              onResize={resizeChat}
              onReset={() => resizeChat(CHAT_DEFAULT_WIDTH, true)}
            />
            <ChatPanel
              bridge={bridge}
              onClose={() => setChatOpen(false)}
              onOpenConsiderations={() => setShowConsiderations(true)}
              onOpenSettings={() => setShowSettings(true)}
            />
          </div>
        )}
      </div>

      {showConsiderations && (
        <ConsiderationsPanel
          considerations={bridge.considerations}
          onAdd={bridge.addConsideration}
          onRemove={bridge.removeConsideration}
          onClose={() => setShowConsiderations(false)}
        />
      )}
      {showAlerts && (
        <AlertsPanel
          state={monitorsState}
          onRemove={(id) => {
            window.stox.removeMonitor(id).catch(() => undefined)
          }}
          onOpenSettings={() => setShowSettings(true)}
          onClose={() => {
            markAlertsSeen()
            setShowAlerts(false)
          }}
        />
      )}
      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onSaved={() => {
            refreshStatus()
            if (chatStarted) bridge.refreshStatus()
            refreshQuotes()
            window.stox.readMonitors().then(setMonitorsState).catch(() => undefined)
          }}
        />
      )}
    </div>
  )
}
