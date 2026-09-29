import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import readline from 'node:readline'
import type { BackendCommand } from './backendCommand'
import type { BridgeCommand, BridgeEvent } from '../shared/bridgeProtocol'

export type BridgeEventListener = (event: BridgeEvent) => void

/**
 * Owns the long-lived Python subprocess (stoxlib/bridge.py) for one app
 * session: one JSON command per line on its stdin, one JSON event per line
 * on its stdout -- see stoxlib/bridge.py's module docstring for the
 * protocol. An unparseable line is surfaced as an id:null error event
 * rather than silently dropped, and every way the process can end (a crash,
 * a failed spawn, a deliberate stop/restart) emits exactly one
 * backend_exit event, so the renderer can drop requests that will now
 * never be answered instead of waiting on them forever.
 */
export class BridgeProcess {
  private child: ChildProcessWithoutNullStreams | null = null
  // Processes whose end has already been reported (stopped deliberately, or
  // already exited): their late close/error events are ignored, so an old
  // process finishing after restart() can't touch the new one.
  private readonly retired = new WeakSet<ChildProcessWithoutNullStreams>()
  private readonly listeners = new Set<BridgeEventListener>()

  constructor(private readonly resolveCommand: () => BackendCommand) {}

  start(): void {
    if (this.child) return
    const { command, args, cwd } = this.resolveCommand()
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return
      try {
        this.emit(JSON.parse(line) as BridgeEvent)
      } catch {
        this.emit({ id: null, type: 'error', message: `unparseable backend output: ${line}` })
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) this.emit({ id: null, type: 'error', message: text })
    })

    // A write to a process that has died (or never started) fails with
    // EPIPE here; the close/error handlers below already report that.
    child.stdin.on('error', () => undefined)

    // Without this, a failed spawn (e.g. ENOENT: no .venv, or a broken
    // package) is an uncaught exception in the main process -- and 'close'
    // may never fire for it.
    child.on('error', (e) => this.ended(child, `couldn't start the chat backend: ${e.message}`))
    // 'close', not 'exit': it fires only after stdout is drained, so a
    // result the process wrote just before dying is still delivered first.
    child.on('close', (code, signal) =>
      this.ended(child, `backend process exited (${signal ?? `code ${code}`})`)
    )
  }

  get running(): boolean {
    return this.child !== null
  }

  restart(): void {
    this.stop()
    this.start()
  }

  stop(): void {
    const child = this.child
    if (!child) return
    // Reported now rather than when the process actually exits: by then
    // restart() may already have started its replacement and the renderer
    // sent it new requests, which a late exit event would wrongly cancel.
    this.ended(child, null)
    child.kill()
  }

  send(command: BridgeCommand): void {
    if (!this.child) this.start()
    this.child!.stdin.write(JSON.stringify(command) + '\n')
  }

  onEvent(listener: BridgeEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** `message` is null for a deliberate stop, which isn't worth showing. */
  private ended(child: ChildProcessWithoutNullStreams, message: string | null): void {
    if (this.retired.has(child)) return
    this.retired.add(child)
    if (this.child === child) this.child = null
    this.emit({ id: null, type: 'backend_exit', message })
  }

  private emit(event: BridgeEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
