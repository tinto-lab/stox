import type { BridgeCommand, BridgeEvent } from './protocol'

export {}

declare global {
  interface Window {
    stox: {
      send(command: BridgeCommand): void
      restartBackend(): void
      onEvent(listener: (event: BridgeEvent) => void): () => void
      readSettings(): Promise<Record<string, string>>
      saveSettings(values: Record<string, string>): Promise<void>
    }
  }
}
