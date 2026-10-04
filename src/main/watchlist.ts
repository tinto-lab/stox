import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WatchlistEntry } from '../shared/types'

/**
 * The dashboard's pinned tickers, persisted next to the .env file the
 * Settings panel edits (~/.config/stox/) so all of stox's user state lives
 * in one place. Order is the order they're shown in.
 */
const WATCHLIST_PATH = path.join(os.homedir(), '.config', 'stox', 'watchlist.json')

export function readWatchlist(): WatchlistEntry[] {
  let text: string
  try {
    text = fs.readFileSync(WATCHLIST_PATH, 'utf8')
  } catch {
    return [] // no file yet -- start with an empty dashboard
  }
  try {
    const parsed = JSON.parse(text) as { pinned?: unknown }
    if (!Array.isArray(parsed.pinned)) throw new Error('no "pinned" list')
    return parsed.pinned
      .filter((e): e is WatchlistEntry => typeof e?.code === 'string')
      .map((e) => ({ code: e.code, name: typeof e.name === 'string' ? e.name : '' }))
  } catch {
    // Unreadable: set it aside rather than let the next pin overwrite it,
    // so a hand-edit gone wrong is still recoverable.
    fs.renameSync(WATCHLIST_PATH, `${WATCHLIST_PATH}.corrupt-${Date.now()}`)
    return []
  }
}

export function writeWatchlist(entries: WatchlistEntry[]): void {
  fs.mkdirSync(path.dirname(WATCHLIST_PATH), { recursive: true })
  // Write-then-rename, so quitting mid-write can't leave a half-written file.
  const tmp = `${WATCHLIST_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ pinned: entries }, null, 2) + '\n')
  fs.renameSync(tmp, WATCHLIST_PATH)
}
