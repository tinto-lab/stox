import { contextBridge, ipcRenderer } from 'electron'
import type {
  Bar,
  Fundamentals,
  HistoryRange,
  IpcResult,
  MarketStatus,
  QuoteResult,
  StoxApi,
  SymbolMatch,
  Theme,
  VoiceEvent,
  VoiceLanguage,
  VoiceStatus,
  WatchlistEntry
} from '../shared/types'
import type { BridgeCommand, BridgeEvent } from '../shared/bridgeProtocol'

/** Unwraps the main process's IpcResult into a resolved value or a plain Error. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!result.ok) throw new Error(result.error)
  return result.data
}

const stoxApi: StoxApi = {
  quotes: (tickers: string[]) => invoke<QuoteResult>('market:quotes', tickers),
  history: (ticker: string, range: HistoryRange) => invoke<Bar[]>('market:history', ticker, range),
  fundamentals: (ticker: string) => invoke<Fundamentals>('market:fundamentals', ticker),
  search: (query: string) => invoke<SymbolMatch[]>('market:search', query),
  status: () => invoke<MarketStatus>('market:status'),
  readWatchlist: () => invoke<WatchlistEntry[]>('watchlist:read'),
  writeWatchlist: (entries: WatchlistEntry[]) => invoke<void>('watchlist:write', entries),
  send(command: BridgeCommand): void {
    void ipcRenderer.invoke('bridge:send', command)
  },
  onEvent(listener: (event: BridgeEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, payload: BridgeEvent): void => listener(payload)
    ipcRenderer.on('bridge:event', handler)
    return () => ipcRenderer.removeListener('bridge:event', handler)
  },
  readSettings: () => invoke<Record<string, string>>('settings:read'),
  saveSettings: (values: Record<string, string>) => invoke<void>('settings:save', values),
  getTheme: () => invoke<Theme>('appearance:get'),
  setTheme: (theme: Theme) => invoke<void>('appearance:set', theme),
  voiceStatus: () => invoke<VoiceStatus>('voice:status'),
  voicePrepare: () => invoke<void>('voice:prepare'),
  voiceStart: () => invoke<void>('voice:start'),
  voicePush(samples: Int16Array): void {
    ipcRenderer.send('voice:push', samples)
  },
  setVoiceLanguage: (language: VoiceLanguage) => invoke<void>('voice:set-language', language),
  setVoicePolish: (enabled: boolean) => invoke<void>('voice:set-polish', enabled),
  polishSpeech: (text: string) => invoke<string>('voice:polish', text),
  voiceStopServer: () => invoke<void>('voice:stop-server'),
  voiceStop: () => invoke<void>('voice:stop'),
  voiceCancel(): void {
    void ipcRenderer.invoke('voice:cancel')
  },
  onVoiceEvent(listener: (event: VoiceEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, payload: VoiceEvent): void => listener(payload)
    ipcRenderer.on('voice:event', handler)
    return () => ipcRenderer.removeListener('voice:event', handler)
  },
}

contextBridge.exposeInMainWorld('stox', stoxApi)
