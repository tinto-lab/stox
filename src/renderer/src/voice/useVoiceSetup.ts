import { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceStatus } from '../../../shared/types'

export type SetupPhase = 'idle' | 'downloading' | 'starting'

/**
 * The state of voice input -- the speech model on disk and the whisper
 * server running -- and the actions to change it. One instance lives in
 * App, shared by the chat panel (mic button and its status dot) and the
 * Settings panel (where the setup happens).
 *
 * `autoStart` brings the server up in the background when the model is
 * already downloaded, so the mic is ready by the time it's needed.
 */
export function useVoiceSetup(autoStart: boolean) {
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [phase, setPhase] = useState<SetupPhase>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.stox.voiceStatus())
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
    return window.stox.onVoiceEvent((event) => {
      if (event.type === 'server') setStatus((s) => (s ? { ...s, server: event.state } : s))
      else if (event.type === 'model-progress') {
        setProgress(event.fraction)
        if (event.fraction >= 1) setPhase('starting')
      }
    })
  }, [refresh])

  /** Downloads the model if it isn't there, then starts the server. */
  const prepare = useCallback(async (modelAlreadyThere: boolean) => {
    if (running.current) return
    running.current = true
    setError(null)
    setProgress(0)
    setPhase(modelAlreadyThere ? 'starting' : 'downloading')
    try {
      await window.stox.voicePrepare()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      running.current = false
      setPhase('idle')
      await refresh()
    }
  }, [refresh])

  const stopServer = useCallback(async () => {
    try {
      await window.stox.voiceStopServer()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const canAutoStart = !!status?.available && status.modelReady && status.server === 'stopped'
  const autoTried = useRef(false)
  useEffect(() => {
    if (autoStart && canAutoStart && !autoTried.current) {
      autoTried.current = true
      void prepare(true)
    }
  }, [autoStart, canAutoStart, prepare])

  return {
    status,
    phase,
    progress,
    error,
    ready: !!status?.available && status.modelReady && status.server === 'running',
    prepare,
    stopServer
  }
}

export type VoiceSetup = ReturnType<typeof useVoiceSetup>
