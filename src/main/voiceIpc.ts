import path from 'node:path'
import { app, ipcMain, systemPreferences } from 'electron'
import { type VoiceSession, createVoiceSession } from '../core/voiceSession'
import { WhisperServer, ensureModel, modelReady } from '../core/whisper'
import type { VoiceEvent, VoiceLanguage, VoiceStatus } from '../shared/types'
import { handle } from './ipc'
import { getVoiceLanguage, setVoiceLanguage } from './preferences'

/**
 * Voice dictation (see VoiceApi): whisper.cpp's server, started on first
 * use. The binary ships in the app's resources; a dev checkout keeps it
 * under build/bin. Returns what to call when the app quits.
 */
export function registerVoiceIpc(sendVoice: (event: VoiceEvent) => void): { shutdown(): void } {
  const whisper = new WhisperServer(
    app.isPackaged
      ? path.join(process.resourcesPath, 'bin', 'whisper-server')
      : path.resolve(__dirname, '..', '..', 'build', 'bin', 'whisper-server'),
    (state) => sendVoice({ type: 'server', state })
  )
  whisper.language = getVoiceLanguage()
  let voice: VoiceSession | null = null

  handle('voice:status', (): VoiceStatus => ({
    available: whisper.available(),
    modelReady: modelReady(),
    server: whisper.currentState(),
    language: getVoiceLanguage()
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
  handle('voice:set-language', (language: VoiceLanguage) => {
    setVoiceLanguage(language)
    whisper.language = language // applies from the next request
  })
  handle('voice:cancel', () => {
    voice?.cancel()
    voice = null
  })

  return { shutdown: () => whisper.stop() }
}
