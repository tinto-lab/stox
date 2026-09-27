import path from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type { BridgeCommand } from '../shared/bridgeProtocol'
import type { IpcResult, Theme, WatchlistEntry } from '../shared/types'
import { resolveBackendCommand } from './backendCommand'
import { BridgeProcess } from './bridgeProcess'
import { readEnvFile, writeEnvFile } from './envFile'
import { fetchFundamentals, fetchHistory, fetchQuotes, hasEodhdKey, searchSymbols } from './marketData'
import { applyTheme, getTheme, setTheme } from './preferences'
import { readWatchlist, writeWatchlist } from './watchlist'

let mainWindow: BrowserWindow | null = null

// The Python backend only powers the chat side panel, so it isn't spawned at
// launch -- BridgeProcess.send() starts it on the first chat command. The
// dashboard and stock views never touch it (see marketData.ts).
const bridge = new BridgeProcess(resolveBackendCommand)

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

// Registered once for the process's lifetime, not per-window: it reads
// `mainWindow` live, so it doesn't need re-registering when a window is
// closed and reopened (e.g. via the Dock icon) -- doing that inside
// createWindow() would stack one extra listener per reopen, multiplying
// every backend event by however many times the window had been reopened.
bridge.onEvent((event) => {
  mainWindow?.webContents.send('bridge:event', event)
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
  bridge.send(command)
})

ipcMain.handle('bridge:restart', () => {
  bridge.restart()
})

handle('settings:read', readEnvFile)
handle('settings:save', (values: Record<string, string>) => {
  writeEnvFile(values)
  // A running backend read its keys at startup; restart it to pick up the new ones.
  // Market data re-reads the file on every request, so it needs nothing.
  if (bridge.running) bridge.restart()
})

handle('appearance:get', getTheme)
handle('appearance:set', (theme: Theme) => setTheme(theme))

app.whenReady().then(() => {
  // Applied before the window exists so it opens in the chosen theme, with no
  // flash of the system one.
  applyTheme(getTheme())
  createWindow()
})

app.on('window-all-closed', () => {
  bridge.stop()
  if (process.platform !== 'darwin') app.quit()
})

// Belt-and-suspenders alongside window-all-closed: guarantees the Python
// subprocess is killed on every quit path (Cmd+Q, Dock > Quit, ...).
// BridgeProcess.stop() is a no-op if it's already stopped.
app.on('before-quit', () => {
  bridge.stop()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
