/**
 * Audio helpers for voice dictation: the renderer captures microphone audio
 * at the device's sample rate; whisper.cpp wants 16 kHz mono.
 */

export const SAMPLE_RATE = 16_000

/** Linear-interpolation resample of mono float samples to 16 kHz Int16. */
export function resampleTo16k(input: Float32Array, inRate: number): Int16Array {
  const ratio = inRate / SAMPLE_RATE
  const outLength = Math.floor(input.length / ratio)
  const out = new Int16Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = pos - i0
    const sample = input[i0] * (1 - frac) + input[i1] * frac
    out[i] = Math.max(-1, Math.min(1, sample)) * 0x7fff
  }
  return out
}

/** Root-mean-square level of Int16 samples, 0..1. */
export function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (const s of samples) sum += (s / 0x8000) ** 2
  return Math.sqrt(sum / samples.length)
}

/** A 16-bit mono PCM WAV file. */
export function encodeWav(samples: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 2
  const out = new Uint8Array(44 + dataBytes)
  const view = new DataView(out.buffer)
  const tag = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  tag(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  tag(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true)
  return out
}

/** Speech must exceed the background level by this factor to start... */
const ON_RATIO = 3
/** ...and falls back below this factor to count as silence again. */
const OFF_RATIO = 2
/** Never call anything quieter than this (about -50 dBFS) speech, even in a dead-quiet room. */
const MIN_SPEECH_LEVEL = 0.003
/** The background estimate is capped, so a recording that opens mid-word
 * can't set a floor above the speech itself. */
const MAX_NOISE = 0.01
const MIN_NOISE = 0.0005
/** First-order high-pass cutoff, to ignore rumble, hum and DC offset. */
const HIGH_PASS_HZ = 100

/**
 * Tells speech from background noise by comparing each chunk's level with
 * the room's own noise floor, so a noisy room doesn't read as speech forever
 * and a quiet speaker is still heard (a fixed volume threshold gets one of
 * the two wrong). The floor falls to any quieter level at once and creeps
 * up only during silence. Hysteresis keeps a word's quiet tail from
 * flickering. Feed it consecutive chunks of one recording.
 */
export class SpeechDetector {
  private noise: number | null = null
  private speaking = false
  private prevIn = 0
  private prevOut = 0
  private readonly alpha: number

  constructor(sampleRate = SAMPLE_RATE) {
    const rc = 1 / (2 * Math.PI * HIGH_PASS_HZ)
    this.alpha = rc / (rc + 1 / sampleRate)
  }

  /** The chunk's level after the high-pass filter, 0..1. */
  private level(samples: Int16Array): number {
    let sum = 0
    for (const s of samples) {
      const x = s / 0x8000
      this.prevOut = this.alpha * (this.prevOut + x - this.prevIn)
      this.prevIn = x
      sum += this.prevOut * this.prevOut
    }
    return samples.length ? Math.sqrt(sum / samples.length) : 0
  }

  /** Whether this chunk is speech. */
  update(samples: Int16Array): boolean {
    const level = this.level(samples)
    if (this.noise === null) this.noise = Math.min(Math.max(level, MIN_NOISE), MAX_NOISE)
    const ratio = this.speaking ? OFF_RATIO : ON_RATIO
    this.speaking = level > Math.max(MIN_SPEECH_LEVEL, this.noise * ratio)
    if (!this.speaking) {
      // Quieter: follow it down at once. Louder: drift up, slowly.
      this.noise = level < this.noise ? Math.max(level, MIN_NOISE) : Math.min(this.noise + (level - this.noise) * 0.05, MAX_NOISE)
    }
    return this.speaking
  }
}
