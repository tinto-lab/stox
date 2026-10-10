import { SAMPLE_RATE, SpeechDetector, conditionAudio, encodeWav } from '../shared/audio'
import type { VoiceEvent } from '../shared/types'

/** Turns WAV audio into text (Gemma in the app, a fake in tests). */
export interface Transcriber {
  /** `onText`, if given, hears the text so far as the recognizer produces it. */
  transcribe(wav: Uint8Array, onText?: (text: string) => void): Promise<string>
}

/** How often the growing utterance is re-transcribed to refresh the preview. */
export const PARTIAL_INTERVAL_MS = 600
/** Silence after speech that ends an utterance and commits its text. */
export const SILENCE_COMMIT_MS = 700
/** A run-on utterance is cut here so each pass stays fast. */
export const MAX_UTTERANCE_MS = 15_000
/** Audio kept across a cut so the next utterance doesn't lose its first word. */
const OVERLAP_MS = 200

const ms = (samples: number): number => (samples / SAMPLE_RATE) * 1000

/** Speech models can emit tags like [BLANK_AUDIO] or (music) for non-speech. */
function clean(text: string): string {
  const t = text.trim()
  return /^[[(].*[\])]$/.test(t) ? '' : t
}

/** Text reduced to its words, so a pass that differs only in punctuation or case counts as the same. */
const sameWords = (text: string): string =>
  text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim()

export interface VoiceSession {
  /** 16 kHz mono Int16 audio, as it is captured. */
  push(samples: Int16Array): void
  /** Ends the session: commits what is left, then emits `done`. */
  stop(): Promise<void>
  /** Ends the session silently, dropping pending text. */
  cancel(): void
}

/**
 * Streaming on top of a non-streaming recognizer. The audio since the last
 * commit (the "utterance") is re-transcribed every PARTIAL_INTERVAL_MS and
 * sent as a `partial` -- the tentative text the user watches change. After a
 * pause, or at MAX_UTTERANCE_MS, it is transcribed once more and sent as a
 * `commit`, and the buffer starts over.
 */
export function createVoiceSession(transcriber: Transcriber, emit: (event: VoiceEvent) => void): VoiceSession {
  const detector = new SpeechDetector()
  let chunks: Int16Array[] = []
  let bufferedSamples = 0
  let hasSpeech = false
  let silenceMs = 0
  let dirty = false // audio arrived since the last partial request
  let epoch = 0 // bumped on commit/cancel, so a late partial of an old utterance is dropped
  let partialInFlight = false
  let preview = '' // the last partial sent for this utterance
  let queue: Promise<void> = Promise.resolve()
  let ended = false

  const snapshot = (): Int16Array => {
    const all = new Int16Array(bufferedSamples)
    let offset = 0
    for (const c of chunks) {
      all.set(c, offset)
      offset += c.length
    }
    return all
  }

  const reset = (keep: Int16Array): void => {
    chunks = keep.length ? [keep] : []
    bufferedSamples = keep.length
    hasSpeech = false
    silenceMs = 0
    dirty = false
    preview = ''
    epoch++
  }

  const fail = (e: unknown): void => emit({ type: 'error', message: e instanceof Error ? e.message : String(e) })

  const requestPartial = (): void => {
    if (ended || partialInFlight || !hasSpeech || !dirty) return
    dirty = false
    partialInFlight = true
    const myEpoch = epoch
    const wav = encodeWav(conditionAudio(snapshot()))
    // Queued behind any commit so results come back in order.
    queue = queue.then(async () => {
      try {
        if (myEpoch !== epoch) return
        // The text grows word by word as the recognizer produces it, then
        // the finished result lands (it may differ slightly from the last word).
        // Every pass re-reads the whole utterance, so it streams in from the
        // first word again. Until it passes the words already on screen it
        // stays quiet, so the preview only ever grows or is corrected by a
        // finished pass. An empty pass (the recognizer gave up) changes nothing.
        const live = (raw: string, finished = false): void => {
          const text = clean(raw)
          if (!text || text === preview || myEpoch !== epoch || ended) return
          if (!finished && sameWords(preview).startsWith(sameWords(text))) return
          preview = text
          emit({ type: 'partial', text })
        }
        live(await transcriber.transcribe(wav, (text) => live(text)), true)
      } catch (e) {
        fail(e)
      } finally {
        partialInFlight = false
      }
    })
  }

  const commit = (): void => {
    if (!hasSpeech) return
    const audio = snapshot()
    const tail = audio.slice(Math.max(0, audio.length - Math.round((OVERLAP_MS / 1000) * SAMPLE_RATE)))
    reset(tail)
    const wav = encodeWav(conditionAudio(audio))
    queue = queue.then(async () => {
      try {
        emit({ type: 'commit', text: clean(await transcriber.transcribe(wav)) })
      } catch (e) {
        fail(e)
      }
    })
  }

  const timer = setInterval(requestPartial, PARTIAL_INTERVAL_MS)

  return {
    push(samples) {
      if (ended) return
      chunks.push(samples)
      bufferedSamples += samples.length
      dirty = true
      if (detector.update(samples)) {
        hasSpeech = true
        silenceMs = 0
      } else {
        silenceMs += ms(samples.length)
      }
      if (!hasSpeech) {
        // Only leading silence so far: keep just the overlap's worth.
        const all = snapshot()
        const keep = all.slice(Math.max(0, all.length - Math.round((OVERLAP_MS / 1000) * SAMPLE_RATE)))
        chunks = [keep]
        bufferedSamples = keep.length
      } else if (silenceMs >= SILENCE_COMMIT_MS || ms(bufferedSamples) >= MAX_UTTERANCE_MS) {
        commit()
      }
    },
    async stop() {
      if (ended) return
      clearInterval(timer)
      commit()
      await queue
      ended = true
      emit({ type: 'done' })
    },
    cancel() {
      ended = true
      clearInterval(timer)
      epoch++
    }
  }
}
