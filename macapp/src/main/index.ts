import path from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { loadEnv, parseEnvFile, userEnvPath, writeUserEnv } from '../core/config'
import { fetchFundamentals, fetchHistory, fetchQuotes, hasEodhdKey, searchSymbols } from '../core/marketData'
import { sendWhatsapp } from '../core/notify'
import { ChatSession } from '../core/session'
import type { BridgeCommand } from '../shared/bridgeProtocol'
import type { IpcResult, Theme, WatchlistEntry } from '../shared/types'
import { MonitorService } from './monitors'
import { applyTheme, getTheme, setTheme } from './preferences'
import { readWatchlist, writeWatchlist } from './watchlist'

let mainWindow: BrowserWindow | null = null

// API keys and settings live in ~/.config/stox/.env (the Settings panel
// edits it). A dev checkout's own .env is read too, as the CLI does --
// __dirname at runtime is macapp/out/main, three levels below the repo root.
const projectEnvFile = app.isPackaged ? undefined : path.resolve(__dirname, '..', '..', '..', '.env')
loadEnv(projectEnvFile)

// Refuse to run as a second instance: double-clicking the Dock icon (or
// `open`-ing the app) while it's already running would otherwise start a
// wholly separate process -- exactly how a stale process from a previous
// build can keep running unnoticed alongside a freshly rebuilt one. The
// second launch quits immediately; the first just focuses its window.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    } else {
      createWindow()
    }
  })
}

// The chat panel's conversation. It reads `mainWindow` live, so it outlives
// a window being closed and reopened (e.g. via the Dock icon).
const chat = new ChatSession((event) => {
  mainWindow?.webContents.send('bridge:event', event)
})

// The news monitor loop runs from launch (whenever a monitor exists) until
// quit, window or not.
const monitorService = new MonitorService(() => {
  mainWindow?.webContents.send('monitors:changed')
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: 'Stox',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Links (e.g. a company's website) open in the default browser, not in the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/** Registers an IPC handler whose failures come back as {ok: false, error}
 * (see IpcResult) rather than as a rejected invoke. */
function handle<A extends unknown[], T>(channel: string, fn: (...args: A) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResult<T>> => {
    try {
      return { ok: true, data: await fn(...(args as A)) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

handle('market:quotes', fetchQuotes)
handle('market:history', fetchHistory)
handle('market:fundamentals', fetchFundamentals)
handle('market:search', searchSymbols)
handle('market:status', () => ({ hasEodhdKey: hasEodhdKey() }))

handle('watchlist:read', readWatchlist)
handle('watchlist:write', (entries: WatchlistEntry[]) => writeWatchlist(entries))

ipcMain.handle('bridge:send', (_event, command: BridgeCommand) => {
  chat.handle(command)
})

handle('settings:read', () => parseEnvFile(userEnvPath()))
handle('settings:save', (values: Record<string, string>) => {
  writeUserEnv(values)
  loadEnv(projectEnvFile)
  // The provider or model may have changed under a conversation in flight.
  chat.restart()
})

handle('monitors:read', () => monitorService.state())
handle('monitors:remove', (id: string) => monitorService.remove(id))
handle('monitors:testAlert', () => sendWhatsapp('✅ Stox test alert -- WhatsApp alerts are working.'))

handle('appearance:get', getTheme)
handle('appearance:set', (theme: Theme) => setTheme(theme))

app.whenReady().then(() => {
  // Applied before the window exists so it opens in the chosen theme, with no
  // flash of the system one.
  applyTheme(getTheme())
  createWindow()
  monitorService.start()
})

// The monitor keeps running here on purpose: on macOS the app lives on
// after its last window closes, and alerts should too.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  monitorService.stop()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
