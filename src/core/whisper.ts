import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { configDir } from './config'
import type { ServerState } from '../shared/types'
import type { Transcriber } from './voiceSession'

const MODEL_NAME = 'ggml-base-q5_1.bin'
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`
/** A truncated download is far smaller; this catches an error page or a cut-off. */
const MODEL_MIN_BYTES = 40_000_000
/** The server is stopped this long after its last transcription. */
const IDLE_STOP_MS = 10 * 60_000

export function modelPath(): string {
  return path.join(configDir(), 'models', MODEL_NAME)
}

export function modelReady(): boolean {
  try {
    return fs.statSync(modelPath()).size >= MODEL_MIN_BYTES
  } catch {
    return false
  }
}

/** Downloads the speech model once, to a temp name that is renamed on success. */
export async function ensureModel(onProgress: (fraction: number) => void, fetchFn: typeof fetch = fetch): Promise<string> {
  const target = modelPath()
  if (modelReady()) return target
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const res = await fetchFn(MODEL_URL, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Downloading the speech model failed (HTTP ${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  const tmp = `${target}.part`
  const out = fs.createWriteStream(tmp)
  let received = 0
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      received += chunk.length
      if (total) onProgress(Math.min(1, received / total))
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))
    if (received < MODEL_MIN_BYTES) throw new Error('The speech model download was incomplete')
    fs.renameSync(tmp, target)
  } catch (e) {
    out.destroy()
    fs.rmSync(tmp, { force: true })
    throw e
  }
  return target
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

/**
 * whisper.cpp's `whisper-server`, started on first use so the model is
 * loaded once rather than per request, and stopped after a minute idle.
 */
export class WhisperServer implements Transcriber {
  private proc: ChildProcess | null = null
  private starting: Promise<string> | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private model = ''
  /** Sent with every request; 'auto' lets whisper detect it. */
  language = 'auto'
  private state: ServerState = 'stopped'

  constructor(
    private readonly binary: string,
    private readonly onState: (state: ServerState) => void = () => {}
  ) {}

  private setState(state: ServerState): void {
    if (this.state === state) return
    this.state = state
    this.onState(state)
  }

  available(): boolean {
    return fs.existsSync(this.binary)
  }

  /** Whether the server is up and answering. */
  running(): boolean {
    return this.state === 'running'
  }

  currentState(): ServerState {
    return this.state
  }

  /** Starts the server (no-op if running); resolves to its base URL. */
  start(model: string): Promise<string> {
    this.model = model
    if (!this.starting) this.setState('starting')
    this.starting ??= this.launch(model).catch((e) => {
      this.starting = null
      this.setState('stopped')
      throw e
    })
    return this.starting
  }

  private async launch(model: string): Promise<string> {
    if (!this.available()) throw new Error('Voice input is unavailable: the whisper binary is missing (run scripts/fetch-whisper.sh)')
    const port = await freePort()
    const proc = spawn(this.binary, [
      '-m', model, '--host', '127.0.0.1', '--port', String(port), '-l', 'auto',
      // Each request is a self-contained utterance. Without this, whisper
      // is prompted with the previous request's text, which biases (and can
      // repeat) it -- especially a new dictation after an earlier one.
      '--no-context'
    ], {
      stdio: 'ignore'
    })
    this.proc = proc
    let exited = false
    proc.once('exit', () => {
      exited = true
      if (this.proc === proc) this.proc = null
      this.starting = null
      this.setState('stopped')
    })
    proc.once('error', () => {
      exited = true
    })
    const base = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (exited) throw new Error('The whisper server exited while starting')
      try {
        await fetch(base, { signal: AbortSignal.timeout(500) })
        this.armIdleStop()
        this.setState('running')
        return base
      } catch {
        await new Promise((r) => setTimeout(r, 150))
      }
    }
    proc.kill()
    throw new Error('The whisper server did not start in time')
  }

  async transcribe(wav: Uint8Array): Promise<string> {
    // Restarts transparently if the idle timer stopped it mid-session.
    const base = await this.start(this.model)
    this.armIdleStop()
    const form = new FormData()
    form.set('file', new Blob([Buffer.from(wav)], { type: 'audio/wav' }), 'audio.wav')
    form.set('response_format', 'json')
    form.set('temperature', '0')
    form.set('language', this.language)
    const res = await fetch(`${base}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`Transcription failed (HTTP ${res.status})`)
    const body = (await res.json()) as { text?: string; error?: string }
    if (body.error) throw new Error(body.error)
    return (body.text ?? '').replace(/\s+/g, ' ').trim()
  }

  private armIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.stop(), IDLE_STOP_MS)
    this.idleTimer.unref()
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.proc?.kill()
    this.proc = null
    this.starting = null
    this.setState('stopped')
  }
}
