import path from 'node:path'
import { app, BrowserWindow, ipcMain, session, shell, systemPreferences } from 'electron'
import { loadEnv, parseEnvFile, userEnvPath, writeUserEnv } from '../core/config'
import { fetchFundamentals, fetchHistory, fetchQuotes, hasEodhdKey, searchSymbols } from '../core/marketData'
import { ChatSession } from '../core/session'
import { createVoiceSession, type VoiceSession } from '../core/voiceSession'
import { WhisperServer, ensureModel, modelReady } from '../core/whisper'
import type { BridgeCommand } from '../shared/bridgeProtocol'
import type { IpcResult, Theme, VoiceEvent, VoiceStatus, WatchlistEntry } from '../shared/types'
import { applyTheme, getTheme, setTheme } from './preferences'
import { readWatchlist, writeWatchlist } from './watchlist'

let mainWindow: BrowserWindow | null = null

// API keys and settings live in ~/.config/stox/.env (the Settings panel
// edits it). A dev checkout's own .env is read too, as the CLI does --
// __dirname at runtime is out/main, two levels below the repo root.
const projectEnvFile = app.isPackaged ? undefined : path.resolve(__dirname, '..', '..', '.env')
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

const sendVoice = (event: VoiceEvent): void => {
  mainWindow?.webContents.send('voice:event', event)
}

// Voice dictation: whisper.cpp's server, started on first use. The binary
// ships in the app's resources; a dev checkout keeps it under build/bin.
const whisper = new WhisperServer(
  app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'whisper-server')
    : path.resolve(__dirname, '..', '..', 'build', 'bin', 'whisper-server'),
  (state) => sendVoice({ type: 'server', state })
)
let voice: VoiceSession | null = null

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


handle('voice:status', (): VoiceStatus => ({
  available: whisper.available(),
  modelReady: modelReady(),
  server: whisper.currentState()
}))
let preparing: Promise<void> | null = null
handle('voice:prepare', () => {
  preparing ??= (async () => {
    if (!whisper.available()) throw new Error('Voice input is unavailable: the whisper binary is missing')
    const model = await ensureModel((fraction) => sendVoice({ type: 'model-progress', fraction }))
    await whisper.start(model)
  })().finally(() => {
    preparing = null
  })
  return preparing
})
handle('voice:start', async () => {
  if (!whisper.running()) throw new Error('Voice input is not ready yet')
  if (process.platform === 'darwin' && !(await systemPreferences.askForMediaAccess('microphone'))) {
    throw new Error('Microphone access was denied. Allow Stox under System Settings > Privacy & Security > Microphone.')
  }
  voice?.cancel()
  voice = createVoiceSession(whisper, sendVoice)
})
ipcMain.on('voice:push', (_event, buffer: ArrayBuffer | Uint8Array) => {
  if (!voice) return
  const bytes = ArrayBuffer.isView(buffer) ? buffer : new Uint8Array(buffer)
  voice.push(new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)))
})
handle('voice:stop', async () => {
  const ending = voice
  voice = null
  await ending?.stop()
})
handle('voice:stop-server', () => {
  voice?.cancel()
  voice = null
  whisper.stop()
})
handle('voice:cancel', () => {
  voice?.cancel()
  voice = null
})

handle('appearance:get', getTheme)
handle('appearance:set', (theme: Theme) => setTheme(theme))

app.whenReady().then(() => {
  // Applied before the window exists so it opens in the chosen theme, with no
  // flash of the system one.
  applyTheme(getTheme())
  // The microphone is the only permission the app ever needs.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'media'))
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => whisper.stop())

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
