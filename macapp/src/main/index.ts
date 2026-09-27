import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { resolveBackendCommand } from './backendCommand'
import { BridgeProcess } from './bridgeProcess'
import { readEnvFile, writeEnvFile } from './envFile'
import type { BridgeCommand } from './protocol'

let mainWindow: BrowserWindow | null = null
const bridge = new BridgeProcess(resolveBackendCommand)

// Refuse to run as a second instance: without this, double-clicking the
// Dock icon (or `open`-ing the app) while it's already running starts a
// wholly separate process with its own Python backend subprocess, rather
// than focusing the existing window -- confusing on its own, and exactly
// how a stale process from a previous build can keep running unnoticed
// alongside a freshly rebuilt one. The second launch quits immediately;
// the first (already-running) instance just focuses its window instead.
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
// `mainWindow` live (the closure captures the module-level `let`, not a
// snapshot), so it doesn't need re-registering when a window is closed
// and reopened (e.g. via the Dock icon on macOS) -- doing that here
// instead of inside createWindow() would silently stack one extra
// listener per reopen, multiplying every backend event by however many
// times the window had been reopened.
bridge.onEvent((event) => {
  mainWindow?.webContents.send('bridge:event', event)
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 740,
    minWidth: 640,
    minHeight: 480,
    title: 'Stox',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  bridge.start()

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

ipcMain.handle('bridge:send', (_event, command: BridgeCommand) => {
  bridge.send(command)
})

ipcMain.handle('bridge:restart', () => {
  bridge.restart()
})

ipcMain.handle('settings:read', () => readEnvFile())

ipcMain.handle('settings:save', (_event, values: Record<string, string>) => {
  writeEnvFile(values)
  bridge.restart()
})

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  bridge.stop()
  if (process.platform !== 'darwin') app.quit()
})

// Belt-and-suspenders alongside window-all-closed: guarantees the Python
// subprocess is killed on every quit path (Cmd+Q, Dock > Quit, ...), not
// just the "closed the last window" one -- BridgeProcess.stop() is a
// no-op if it's already stopped, so this is safe to call unconditionally.
app.on('before-quit', () => {
  bridge.stop()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
