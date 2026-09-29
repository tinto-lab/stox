import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MonitorsState, NewsAlert, NewsMonitor } from '../shared/types'
import { resolveBackendCommand } from './backendCommand'
import { BridgeProcess } from './bridgeProcess'
import { readEnvFile } from './envFile'

/**
 * News monitors: the files stoxlib/monitors.py keeps under ~/.config/stox/,
 * and the Python loop (stoxlib/watcher.py, `stox_bridge.py --monitor`) that
 * polls them. Monitors are created by the chat agent's create_news_monitor
 * tool, which may run in a different process, so this watches
 * monitors.json rather than being told: the loop runs exactly while at
 * least one monitor exists, and a crashed loop is restarted after a pause.
 */
const CONFIG_DIR = path.join(os.homedir(), '.config', 'stox')
const MONITORS_PATH = path.join(CONFIG_DIR, 'monitors.json')
const ALERTS_PATH = path.join(CONFIG_DIR, 'alerts.jsonl')

const MAX_ALERTS_SHOWN = 50
const CRASH_RESTART_MS = 60_000
const TEST_ALERT_TIMEOUT_MS = 60_000

function readMonitors(): NewsMonitor[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(MONITORS_PATH, 'utf8')) as { monitors?: unknown }
    return Array.isArray(parsed.monitors)
      ? parsed.monitors.filter((m): m is NewsMonitor => typeof m?.id === 'string')
      : []
  } catch {
    return [] // no file yet, or mid-edit by hand -- same as no monitors
  }
}

/** Same file format and write-then-rename as monitors.py's remove_monitor. */
function removeMonitor(id: string): void {
  const remaining = readMonitors().filter((m) => m.id !== id)
  const tmp = `${MONITORS_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ monitors: remaining }, null, 2) + '\n')
  fs.renameSync(tmp, MONITORS_PATH)
}

function readAlerts(): NewsAlert[] {
  let lines: string[]
  try {
    lines = fs.readFileSync(ALERTS_PATH, 'utf8').split('\n')
  } catch {
    return []
  }
  const alerts: NewsAlert[] = []
  for (let i = lines.length - 1; i >= 0 && alerts.length < MAX_ALERTS_SHOWN; i--) {
    if (!lines[i].trim()) continue
    try {
      alerts.push(JSON.parse(lines[i]) as NewsAlert)
    } catch {
      // a torn or hand-mangled line -- skip it
    }
  }
  return alerts
}

export class MonitorService {
  private readonly proc = new BridgeProcess(() => resolveBackendCommand('--monitor'))
  private lastCheckAt: number | null = null
  private lastError: string | null = null
  private restartTimer: NodeJS.Timeout | null = null

  constructor(private readonly onChanged: () => void) {
    this.proc.onEvent((event) => {
      if (event.type === 'monitor_cycle') {
        this.lastCheckAt = event.at
        this.lastError = null
      } else if (event.type === 'error') {
        this.lastError = event.message
      } else if (event.type === 'backend_exit' && event.message) {
        // Crashed (a deliberate stop has no message): try again shortly.
        this.lastError = event.message
        this.restartTimer ??= setTimeout(() => {
          this.restartTimer = null
          this.sync()
        }, CRASH_RESTART_MS)
      }
      this.onChanged()
    })
  }

  /** Starts watching monitors.json, and the loop if any monitor exists. */
  start(): void {
    fs.watchFile(MONITORS_PATH, { interval: 2000 }, () => {
      this.sync()
      this.onChanged()
    })
    this.sync()
  }

  stop(): void {
    fs.unwatchFile(MONITORS_PATH)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.proc.stop()
  }

  remove(id: string): void {
    removeMonitor(id)
    this.sync()
    this.onChanged()
  }

  /** The loop read its keys at startup; restart it to pick up new ones. */
  settingsChanged(): void {
    if (this.proc.running) this.proc.restart()
  }

  state(): MonitorsState {
    const env = readEnvFile()
    return {
      monitors: readMonitors(),
      alerts: readAlerts(),
      running: this.proc.running,
      lastCheckAt: this.lastCheckAt,
      lastError: this.lastError,
      whatsappConfigured: Boolean(env.CALLMEBOT_PHONE && env.CALLMEBOT_APIKEY)
    }
  }

  private sync(): void {
    const wanted = readMonitors().length > 0
    if (wanted && !this.proc.running) this.proc.start()
    else if (!wanted && this.proc.running) this.proc.stop()
  }
}

/** One-shot `stox_bridge.py --test-alert`, rejecting with its stderr on failure. */
export function sendTestAlert(): Promise<void> {
  const { command, args, cwd } = resolveBackendCommand('--test-alert')
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: TEST_ALERT_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message))
      else resolve()
    })
  })
}
