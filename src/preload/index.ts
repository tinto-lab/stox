import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppearanceApi,
  Bar,
  ChatApi,
  Fundamentals,
  HistoryRange,
  IpcResult,
  MarketApi,
  MarketStatus,
  QuoteResult,
  SettingsApi,
  StoxApi,
  SymbolMatch,
  Theme,
  VoiceApi,
  VoiceEvent,
  VoiceLanguage,
  VoiceStatus,
  WatchlistApi,
  WatchlistEntry
} from '../shared/types'
import type { BridgeCommand, BridgeEvent } from '../shared/bridgeProtocol'

/** Unwraps the main process's IpcResult into a resolved value or a plain Error. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!result.ok) throw new Error(result.error)
  return result.data
}

/** Subscribes `listener` to events the main process sends on `channel`; returns the unsubscribe. */
function subscribe<T>(channel: string, listener: (event: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const market: MarketApi = {
  quotes: (tickers: string[]) => invoke<QuoteResult>('market:quotes', tickers),
  history: (ticker: string, range: HistoryRange) => invoke<Bar[]>('market:history', ticker, range),
  fundamentals: (ticker: string) => invoke<Fundamentals>('market:fundamentals', ticker),
  search: (query: string) => invoke<SymbolMatch[]>('market:search', query),
  status: () => invoke<MarketStatus>('market:status')
}

const watchlist: WatchlistApi = {
  readWatchlist: () => invoke<WatchlistEntry[]>('watchlist:read'),
  writeWatchlist: (entries: WatchlistEntry[]) => invoke<void>('watchlist:write', entries)
}

const chat: ChatApi = {
  send(command: BridgeCommand): void {
    void ipcRenderer.invoke('bridge:send', command)
  },
  onEvent: (listener: (event: BridgeEvent) => void) => subscribe('bridge:event', listener)
}

const settings: SettingsApi = {
  readSettings: () => invoke<Record<string, string>>('settings:read'),
  saveSettings: (values: Record<string, string>) => invoke<void>('settings:save', values)
}

const appearance: AppearanceApi = {
  getTheme: () => invoke<Theme>('appearance:get'),
  setTheme: (theme: Theme) => invoke<void>('appearance:set', theme)
}

const voice: VoiceApi = {
  voiceStatus: () => invoke<VoiceStatus>('voice:status'),
  voicePrepare: () => invoke<void>('voice:prepare'),
  voiceStart: () => invoke<void>('voice:start'),
  voicePush(samples: Int16Array): void {
    ipcRenderer.send('voice:push', samples)
  },
  setVoiceLanguage: (language: VoiceLanguage) => invoke<void>('voice:set-language', language),
  voiceStopServer: () => invoke<void>('voice:stop-server'),
  voiceStop: () => invoke<void>('voice:stop'),
  voiceCancel(): void {
    void ipcRenderer.invoke('voice:cancel')
  },
  onVoiceEvent: (listener: (event: VoiceEvent) => void) => subscribe('voice:event', listener)
}

const stoxApi: StoxApi = { ...market, ...watchlist, ...chat, ...settings, ...appearance, ...voice }

contextBridge.exposeInMainWorld('stox', stoxApi)
