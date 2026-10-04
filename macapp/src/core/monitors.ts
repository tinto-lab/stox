import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { NewsAlert, NewsMonitor } from '../shared/types'
import { configDir, readJson, writeJsonAtomic } from './config'

/**
 * News monitors: standing "alert me when ..." requests, persisted to disk.
 *
 * A monitor is the user's goal in their own words ("alert me when crude oil
 * or tanker rates are likely to rise") plus what the agent derived from it:
 * a handful of short news searches covering the goal's drivers ("Iran",
 * "Strait of Hormuz", "OPEC output") and the tickers it's about.
 * watcher.ts polls those searches and decides which new headlines deserve
 * an alert; this module only stores things.
 *
 * Three files under ~/.config/stox/, next to considerations.txt:
 *
 *     monitors.json         the monitors -- written by the chat agent, the
 *                           CLI and the app's Alerts panel
 *     monitor_state.json    headlines each monitor has already seen
 *     alerts.jsonl          every alert raised, newest last
 *
 * Whole-file writes are write-then-rename, so a reader in another process
 * (the CLI, the app) never sees a half-written file.
 */

export const monitorsPath = (): string => path.join(configDir(), 'monitors.json')
export const statePath = (): string => path.join(configDir(), 'monitor_state.json')
export const alertsPath = (): string => path.join(configDir(), 'alerts.jsonl')

// Per monitor. A monitor with 6 queries sees at most ~60 headlines a poll,
// and a headline only needs remembering while the feed's lookback window
// still returns it, so this comfortably covers a day.
export const MAX_SEEN_PER_MONITOR = 1000

/** {monitor id: [seen headline key, ...]}, oldest first. */
export type MonitorState = Record<string, string[]>

export function loadMonitors(): NewsMonitor[] {
  const data = readJson(monitorsPath()) as { monitors?: unknown } | undefined
  const monitors = data && typeof data === 'object' ? data.monitors : undefined
  if (!Array.isArray(monitors)) return []
  return monitors.filter(
    (m): m is NewsMonitor =>
      typeof m === 'object' && m !== null && typeof m.id === 'string' && Array.isArray(m.queries) && m.queries.length > 0
  )
}

/** Stores a new monitor and returns it. Blank queries/tickers are dropped
 * and tickers upper-cased; throws if no query is left. */
export function addMonitor(goal: string, queries: string[], tickers: string[]): NewsMonitor {
  const cleanQueries = (queries ?? []).map((q) => String(q ?? '').trim()).filter(Boolean)
  if (!cleanQueries.length) throw new Error('a monitor needs at least one search query')
  const monitor: NewsMonitor = {
    id: randomUUID().replace(/-/g, '').slice(0, 8),
    goal: String(goal ?? '').trim() || cleanQueries[0],
    queries: cleanQueries,
    tickers: (tickers ?? []).map((t) => String(t ?? '').trim().toUpperCase()).filter(Boolean),
    created_at: Math.floor(Date.now() / 1000)
  }
  writeJsonAtomic(monitorsPath(), { monitors: [...loadMonitors(), monitor] })
  return monitor
}

/** Deletes a monitor; false if there's no such id. */
export function removeMonitor(id: string): boolean {
  const monitors = loadMonitors()
  const remaining = monitors.filter((m) => m.id !== id)
  if (remaining.length === monitors.length) return false
  writeJsonAtomic(monitorsPath(), { monitors: remaining })
  return true
}

export function loadState(): MonitorState {
  const data = readJson(statePath())
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as MonitorState) : {}
}

/** Persists `state`, dropping deleted monitors and capping each list. */
export function saveState(state: MonitorState, monitorIds: Set<string>): void {
  const kept: MonitorState = {}
  for (const [id, seen] of Object.entries(state)) {
    if (monitorIds.has(id)) kept[id] = seen.slice(-MAX_SEEN_PER_MONITOR)
  }
  writeJsonAtomic(statePath(), kept)
}

export function appendAlert(alert: NewsAlert): void {
  fs.mkdirSync(configDir(), { recursive: true })
  fs.appendFileSync(alertsPath(), JSON.stringify(alert) + '\n')
}

/** The most recent `limit` alerts, newest first; torn lines are skipped. */
export function loadAlerts(limit = 50): NewsAlert[] {
  let lines: string[]
  try {
    lines = fs.readFileSync(alertsPath(), 'utf8').split('\n')
  } catch {
    return []
  }
  const alerts: NewsAlert[] = []
  for (let i = lines.length - 1; i >= 0 && alerts.length < limit; i--) {
    if (!lines[i].trim()) continue
    try {
      alerts.push(JSON.parse(lines[i]) as NewsAlert)
    } catch {
      // a torn or hand-mangled line
    }
  }
  return alerts
}
