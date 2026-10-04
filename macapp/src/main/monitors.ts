import fs from 'node:fs'
import { loadAlerts, loadMonitors, monitorsPath, removeMonitor } from '../core/monitors'
import { whatsappConfigured } from '../core/notify'
import { Watcher } from '../core/watcher'
import type { MonitorsState } from '../shared/types'

/**
 * Runs the news watcher (src/core/watcher.ts) for as long as the app is
 * open and at least one monitor exists. Monitors are also created by the
 * terminal CLI, a separate process, so this watches monitors.json rather
 * than waiting to be told.
 */
export class MonitorService {
  private lastCheckAt: number | null = null
  private lastError: string | null = null
  private readonly watcher: Watcher

  constructor(private readonly onChanged: () => void) {
    this.watcher = new Watcher({
      onCycle: ({ at }) => {
        this.lastCheckAt = at
        this.lastError = null
        this.onChanged()
      },
      onError: (message) => {
        this.lastError = message
        this.onChanged()
      },
      onAlert: () => this.onChanged()
    })
  }

  /** Starts watching monitors.json, and the loop if any monitor exists. */
  start(): void {
    fs.watchFile(monitorsPath(), { interval: 2000 }, () => {
      this.sync()
      this.onChanged()
    })
    this.sync()
  }

  stop(): void {
    fs.unwatchFile(monitorsPath())
    this.watcher.stop()
  }

  remove(id: string): void {
    removeMonitor(id)
    this.sync()
    this.onChanged()
  }

  state(): MonitorsState {
    return {
      monitors: loadMonitors(),
      alerts: loadAlerts(),
      running: this.watcher.running,
      lastCheckAt: this.lastCheckAt,
      lastError: this.lastError,
      whatsappConfigured: whatsappConfigured()
    }
  }

  private sync(): void {
    const wanted = loadMonitors().length > 0
    if (wanted && !this.watcher.running) this.watcher.start()
    else if (!wanted && this.watcher.running) this.watcher.stop()
  }
}
