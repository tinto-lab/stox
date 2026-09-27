import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { resolveBackendCommand } from './backendCommand'
import { BridgeProcess } from './bridgeProcess'
import { readEnvFile, writeEnvFile } from './envFile'
import type { BridgeCommand } from './protocol'

let mainWindow: BrowserWindow | null = null
const bridge = new BridgeProcess(resolveBackendCommand)

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

  bridge.onEvent((event) => {
    mainWindow?.webContents.send('bridge:event', event)
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

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
