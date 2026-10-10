import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { SAMPLE_RATE, SpeechDetector, encodeWav, resampleTo16k, rms } from '../src/shared/audio'
import { MAX_UTTERANCE_MS, PARTIAL_INTERVAL_MS, SILENCE_COMMIT_MS, createVoiceSession } from '../src/core/voiceSession'
import { ensureModel, modelPath } from '../src/core/whisper'
import type { VoiceEvent } from '../src/shared/types'

/** Samples of a 440 Hz tone (a stand-in for speech: a steady offset would be filtered out as rumble). */
const tone = (ms: number, amplitude: number): Int16Array =>
  Int16Array.from({ length: (SAMPLE_RATE * ms) / 1000 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * amplitude)
const loud = (ms: number): Int16Array => tone(ms, 8000)
/** Deterministic hiss at roughly the given RMS level (0..1). */
function hiss(ms: number, level: number, seed = 1): Int16Array {
  let x = seed
  return Int16Array.from({ length: (SAMPLE_RATE * ms) / 1000 }, () => {
    x = (x * 1664525 + 1013904223) % 4294967296
    return (x / 4294967296 - 0.5) * 2 * Math.sqrt(3) * level * 0x8000
  })
}
const quiet = (ms: number): Int16Array => new Int16Array((SAMPLE_RATE * ms) / 1000)

describe('audio helpers', () => {
  it('encodes a 16-bit mono WAV', () => {
    const wav = encodeWav(Int16Array.of(1, -2, 3))
    const view = new DataView(wav.buffer)
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE')
    expect(view.getUint32(24, true)).toBe(SAMPLE_RATE)
    expect(view.getUint32(40, true)).toBe(6)
    expect(wav.length).toBe(44 + 6)
    expect(view.getInt16(46, true)).toBe(-2)
  })

  it('resamples 48 kHz to 16 kHz', () => {
    const out = resampleTo16k(new Float32Array(4800).fill(0.5), 48_000)
    expect(out.length).toBe(1600)
    expect(out[10]).toBeCloseTo(0.5 * 0x7fff, -1)
  })

  it('measures level', () => {
    expect(rms(quiet(100))).toBe(0)
    expect(rms(loud(100))).toBeGreaterThan(0.1)
  })
})

describe('speech detector', () => {
  /** Runs the detector over 100 ms chunks, returning how many were called speech. */
  const speechChunks = (d: SpeechDetector, audio: Int16Array): number => {
    let n = 0
    for (let i = 0; i < audio.length; i += 1600) if (d.update(audio.slice(i, i + 1600))) n++
    return n
  }
  const mix = (a: Int16Array, b: Int16Array): Int16Array => a.map((v, i) => v + b[i])

  it('hears a quiet voice in a quiet room', () => {
    const d = new SpeechDetector()
    expect(speechChunks(d, hiss(1000, 0.001))).toBe(0)
    // 0.008 RMS tone: below the old fixed 0.012 threshold.
    expect(speechChunks(d, mix(tone(1000, 0.008 * Math.SQRT2 * 0x8000), hiss(1000, 0.001, 2)))).toBeGreaterThanOrEqual(9)
  })

  it('does not take steady background noise for speech', () => {
    const d = new SpeechDetector()
    // 0.02 RMS hiss is above the old fixed threshold, so it would be "speech" all along.
    expect(speechChunks(d, hiss(3000, 0.02))).toBe(0)
  })

  it('hears speech over background noise, and the pause after it', () => {
    const d = new SpeechDetector()
    speechChunks(d, hiss(1000, 0.01))
    expect(speechChunks(d, mix(tone(1000, 6000), hiss(1000, 0.01, 3)))).toBeGreaterThanOrEqual(9)
    expect(speechChunks(d, hiss(1000, 0.01, 4))).toBe(0)
  })

  it('ignores a constant offset and low rumble', () => {
    expect(speechChunks(new SpeechDetector(), new Int16Array(SAMPLE_RATE).fill(6000))).toBe(0)
    expect(speechChunks(new SpeechDetector(), tone(1000, 1500).map((_, i) => Math.sin((2 * Math.PI * 30 * i) / SAMPLE_RATE) * 1500))).toBe(0)
  })

  it('still hears speech when the recording starts mid-word', () => {
    const d = new SpeechDetector()
    expect(speechChunks(d, tone(1000, 4000))).toBeGreaterThanOrEqual(9)
  })
})

describe('voice session', () => {
  let events: VoiceEvent[]
  let calls: number
  let release: (() => void)[]

  /** Answers "text<call number>" once the test releases that call. */
  const slow = {
    transcribe: vi.fn(
      () =>
        new Promise<string>((resolve) => {
          const n = ++calls
          release.push(() => resolve(`text${n}`))
        })
    )
  }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  beforeEach(() => {
    vi.useFakeTimers()
    events = []
    calls = 0
    release = []
    slow.transcribe.mockClear()
  })
  afterEach(() => vi.useRealTimers())

  it('streams partials while speaking, never overlapping requests', async () => {
    const session = createVoiceSession(slow, (e) => events.push(e))
    session.push(loud(300))
    vi.advanceTimersByTime(PARTIAL_INTERVAL_MS)
    await flush()
    session.push(loud(300))
    vi.advanceTimersByTime(PARTIAL_INTERVAL_MS)
    await flush()
    expect(slow.transcribe).toHaveBeenCalledTimes(1) // the second tick waits for the first
    release[0]()
    await flush()
    expect(events).toEqual([{ type: 'partial', text: 'text1' }])
    session.cancel()
  })

  it('commits after a pause and starts the next utterance fresh', async () => {
    const session = createVoiceSession(slow, (e) => events.push(e))
    session.push(loud(500))
    session.push(quiet(SILENCE_COMMIT_MS))
    expect(slow.transcribe).toHaveBeenCalledTimes(0) // queued; runs on a microtask
    await flush()
    expect(slow.transcribe).toHaveBeenCalledTimes(1)
    release[0]()
    await flush()
    expect(events).toEqual([{ type: 'commit', text: 'text1' }])
    // Silence alone starts nothing.
    vi.advanceTimersByTime(PARTIAL_INTERVAL_MS * 3)
    await flush()
    expect(slow.transcribe).toHaveBeenCalledTimes(1)
    session.cancel()
  })

  it('drops a partial that finishes after its utterance was committed', async () => {
    const session = createVoiceSession(slow, (e) => events.push(e))
    session.push(loud(500))
    vi.advanceTimersByTime(PARTIAL_INTERVAL_MS) // partial in flight
    await flush()
    session.push(quiet(SILENCE_COMMIT_MS)) // commit queued behind it
    release[0]()
    await flush()
    release[1]()
    await flush()
    expect(events.map((e) => e.type)).toEqual(['commit'])
    session.cancel()
  })

  it('cuts a run-on utterance', async () => {
    const session = createVoiceSession(slow, (e) => events.push(e))
    for (let t = 0; t < MAX_UTTERANCE_MS; t += 500) session.push(loud(500))
    await flush()
    expect(slow.transcribe).toHaveBeenCalledTimes(1)
    session.cancel()
  })

  it('flushes on stop, then reports done', async () => {
    const session = createVoiceSession(slow, (e) => events.push(e))
    session.push(loud(400))
    const stopped = session.stop()
    await flush()
    release[0]()
    await stopped
    expect(events).toEqual([{ type: 'commit', text: 'text1' }, { type: 'done' }])
  })

  it('filters non-speech tags and reports transcriber failures', async () => {
    const answers: (string | Error)[] = ['[BLANK_AUDIO]', new Error('boom')]
    const t = {
      transcribe: vi.fn(async () => {
        const a = answers.shift()
        if (a instanceof Error) throw a
        return a as string
      })
    }
    const session = createVoiceSession(t, (e) => events.push(e))
    session.push(loud(300))
    session.push(quiet(SILENCE_COMMIT_MS))
    session.push(loud(300))
    session.push(quiet(SILENCE_COMMIT_MS))
    await vi.advanceTimersByTimeAsync(10)
    expect(events).toEqual([
      { type: 'commit', text: '' },
      { type: 'error', message: 'boom' }
    ])
    session.cancel()
  })

  it('emits nothing after cancel', async () => {
    const session = createVoiceSession(slow, (e) => events.push(e))
    session.push(loud(400))
    vi.advanceTimersByTime(PARTIAL_INTERVAL_MS)
    await flush()
    session.cancel()
    release[0]()
    await flush()
    expect(events).toEqual([])
  })
})

describe('ensureModel', () => {
  const body = (bytes: number): Response =>
    new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes) } })

  it('downloads to a temp name, then renames', async () => {
    const progress: number[] = []
    const fetchFn = vi.fn(async () => body(50_000_000)) as unknown as typeof fetch
    expect(await ensureModel((f) => progress.push(f), fetchFn)).toBe(modelPath())
    expect(fs.statSync(modelPath()).size).toBe(50_000_000)
    expect(fs.existsSync(`${modelPath()}.part`)).toBe(false)
    expect(progress.at(-1)).toBe(1)
    await ensureModel(() => {}, fetchFn) // already there
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('leaves nothing behind when the download is cut short', async () => {
    const fetchFn = vi.fn(async () => body(1000)) as unknown as typeof fetch
    await expect(ensureModel(() => {}, fetchFn)).rejects.toThrow(/incomplete/)
    expect(fs.existsSync(modelPath())).toBe(false)
    expect(fs.existsSync(`${modelPath()}.part`)).toBe(false)
  })
})
