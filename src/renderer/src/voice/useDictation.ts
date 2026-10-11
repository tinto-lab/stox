import { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceApi } from '../../../shared/types'
import { startRecorder, type Recorder } from './recorder'

export type DictationState = 'idle' | 'starting' | 'listening' | 'finishing'

/** Thrown inside start() when it was ended before it finished. */
class Cancelled extends Error {}

/** `base` plus the spoken text, spaced like typed words. */
export function joinSpoken(base: string, spoken: string): string {
  if (!spoken) return base
  return base && !/\s$/.test(base) ? `${base} ${spoken}` : `${base}${spoken}`
}

/**
 * Live dictation. While listening, `onText` gets the full text to show
 * (`base` + what has been said so far) on every update; `onEnd` fires once
 * when the session is over, with `cancelled` true if the text should be
 * thrown away.
 */
export function useDictation(
  onText: (text: string) => void,
  onEnd: (cancelled: boolean) => void,
  api: VoiceApi = window.stox
) {
  const [state, setState] = useState<DictationState>('idle')
  const [error, setError] = useState<string | null>(null)
  const recorder = useRef<Recorder | null>(null)
  const stateRef = useRef<DictationState>('idle')
  const startSeq = useRef(0)
  const base = useRef('')
  const committed = useRef('')
  const callbacks = useRef({ onText, onEnd })
  callbacks.current = { onText, onEnd }

  const current = (): DictationState => stateRef.current
  const set = (next: DictationState): void => {
    stateRef.current = next
    setState(next)
  }

  const finish = useCallback((cancelled: boolean) => {
    recorder.current?.stop()
    recorder.current = null
    set('idle')
    callbacks.current.onEnd(cancelled)
  }, [])

  useEffect(
    () =>
      api.onVoiceEvent((event) => {
        if (stateRef.current === 'idle') return
        switch (event.type) {
          case 'partial':
            callbacks.current.onText(joinSpoken(base.current, joinSpoken(committed.current, event.text)))
            break
          case 'commit':
            committed.current = joinSpoken(committed.current, event.text)
            callbacks.current.onText(joinSpoken(base.current, committed.current))
            break
          case 'done':
            finish(false)
            break
          case 'error':
            setError(event.message)
            break
        }
      }),
    [finish]
  )

  // Leaving the panel mid-sentence releases the microphone.
  useEffect(
    () => () => {
      if (stateRef.current !== 'idle') {
        recorder.current?.stop()
        api.voiceCancel()
      }
    },
    []
  )

  const start = useCallback(async (currentText: string) => {
    if (stateRef.current !== 'idle') return
    base.current = currentText
    committed.current = ''
    setError(null)
    set('starting')
    // A start is async (it may wait on the mic permission prompt), so the
    // user can end it and begin another before it finishes. `mine` tells this
    // start apart: a stale one must not touch the newer session's recorder or
    // cancel its main-process session.
    const mine = ++startSeq.current
    const stale = (): boolean => startSeq.current !== mine || current() !== 'starting'
    let started: Recorder | null = null
    try {
      await api.voiceStart()
      if (stale()) throw new Cancelled()
      started = await startRecorder((samples) => api.voicePush(samples))
      if (stale()) throw new Cancelled()
      recorder.current = started
      set('listening')
    } catch (e) {
      started?.stop()
      // Only the latest start owns the main-process session.
      if (startSeq.current === mine) api.voiceCancel()
      if (e instanceof Cancelled || startSeq.current !== mine) return
      setError(e instanceof Error ? e.message : String(e))
      finish(true)
    }
  }, [finish])

  /** Stops listening; the text still being transcribed lands before `onEnd`. */
  const stop = useCallback(async () => {
    if (stateRef.current === 'starting') return finish(true)
    if (stateRef.current !== 'listening') return
    recorder.current?.stop()
    recorder.current = null
    set('finishing')
    try {
      await api.voiceStop() // resolves after the last commit; 'done' then ends the session
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      finish(false)
    }
  }, [finish])

  const cancel = useCallback(() => {
    if (stateRef.current === 'idle') return
    api.voiceCancel()
    finish(true)
  }, [finish])

  return { state, error, start, stop, cancel }
}
