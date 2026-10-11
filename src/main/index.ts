import path from 'node:path'
import { app, BrowserWindow, ipcMain, session, shell } from 'electron'
import { loadEnv } from '../core/config'
import { ChatSession } from '../core/session'
import type { BridgeCommand } from '../shared/bridgeProtocol'
import type { VoiceEvent } from '../shared/types'
import { registerMarketIpc } from './marketIpc'
import { applyTheme, getTheme } from './preferences'
import { registerSettingsIpc } from './settingsIpc'
import { registerVoiceIpc } from './voiceIpc'

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

registerMarketIpc()

ipcMain.handle('bridge:send', (_event, command: BridgeCommand) => {
  chat.handle(command)
})

registerSettingsIpc(projectEnvFile, () => chat.restart())
const voice = registerVoiceIpc(sendVoice)

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

app.on('will-quit', () => voice.shutdown())

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
