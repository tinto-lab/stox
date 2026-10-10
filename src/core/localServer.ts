import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { ServerState } from '../shared/types'

/** The server is stopped this long after its last request. */
const IDLE_STOP_MS = 10 * 60_000
/** A big model can take a while to load. */
const START_TIMEOUT_MS = 60_000

/**
 * Downloads a model file once, to a temp name that is renamed on success.
 * `minBytes` catches an error page or a cut-off download.
 */
export async function downloadModel(
  url: string,
  target: string,
  minBytes: number,
  label: string,
  onProgress: (fraction: number) => void,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const res = await fetchFn(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Downloading the ${label} failed (HTTP ${res.status})`)
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
    if (received < minBytes) throw new Error(`The ${label} download was incomplete`)
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
 * A bundled llama.cpp-family server (llama-server) run as a
 * child process on a free local port. It starts on first use so the model
 * is loaded once rather than per request, and stops after sitting idle.
 */
export abstract class LocalServer {
  private proc: ChildProcess | null = null
  private starting: Promise<string> | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private model = ''
  private state: ServerState = 'stopped'

  constructor(
    private readonly binary: string,
    /** What the server is called in error messages. */
    private readonly label: string,
    private readonly onState: (state: ServerState) => void = () => {}
  ) {}

  /** The command-line arguments that serve `model` on `port`. */
  protected abstract args(model: string, port: number): string[]

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
  start(model: string = this.model): Promise<string> {
    this.model = model
    if (!this.starting) this.setState('starting')
    this.starting ??= this.launch(model).catch((e) => {
      this.starting = null
      this.setState('stopped')
      throw e
    })
    return this.starting
  }

  /** Call on every request: restarts the server if the idle timer stopped
   * it, and postpones the next idle stop. */
  async ready(): Promise<string> {
    const base = await this.start()
    this.armIdleStop()
    return base
  }

  private async launch(model: string): Promise<string> {
    if (!this.available()) throw new Error(`The ${this.label} binary is missing`)
    const port = await freePort()
    const proc = spawn(this.binary, this.args(model, port), { stdio: 'ignore' })
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
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (exited) throw new Error(`The ${this.label} exited while starting`)
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })
        // llama-server answers 503 while the model loads.
        if (res.ok) {
          this.armIdleStop()
          this.setState('running')
          return base
        }
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 150))
    }
    proc.kill()
    throw new Error(`The ${this.label} did not start in time`)
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
