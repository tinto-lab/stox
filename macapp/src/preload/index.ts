import { contextBridge, ipcRenderer } from 'electron'
import type { BridgeCommand, BridgeEvent } from '../main/protocol'

const stoxApi = {
  send(command: BridgeCommand): void {
    void ipcRenderer.invoke('bridge:send', command)
  },
  restartBackend(): void {
    void ipcRenderer.invoke('bridge:restart')
  },
  onEvent(listener: (event: BridgeEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, payload: BridgeEvent): void => listener(payload)
    ipcRenderer.on('bridge:event', handler)
    return () => ipcRenderer.removeListener('bridge:event', handler)
  },
  readSettings(): Promise<Record<string, string>> {
    return ipcRenderer.invoke('settings:read')
  },
  saveSettings(values: Record<string, string>): Promise<void> {
    return ipcRenderer.invoke('settings:save', values)
  }
}

export type StoxApi = typeof stoxApi

contextBridge.exposeInMainWorld('stox', stoxApi)
