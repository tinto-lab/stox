import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import readline from 'node:readline'
import type { BackendCommand } from './backendCommand'
import type { BridgeCommand, BridgeEvent } from '../shared/bridgeProtocol'

export type BridgeEventListener = (event: BridgeEvent) => void

/**
 * Owns the long-lived Python subprocess (stoxlib/bridge.py) for one app
 * session: one JSON command per line on its stdin, one JSON event per line
 * on its stdout -- see stoxlib/bridge.py's module docstring for the
 * protocol. A crash or unparseable line is surfaced as an id:null error
 * event rather than silently dropped, so the renderer can show something
 * instead of a request that never resolves.
 */
export class BridgeProcess {
  private child: ChildProcessWithoutNullStreams | null = null
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

    child.on('exit', (code) => {
      this.child = null
      this.emit({ id: null, type: 'error', message: `backend process exited (code ${code})` })
    })
  }

  get running(): boolean {
    return this.child !== null
  }

  restart(): void {
    this.stop()
    this.start()
  }

  stop(): void {
    this.child?.kill()
    this.child = null
  }

  send(command: BridgeCommand): void {
    if (!this.child) this.start()
    this.child!.stdin.write(JSON.stringify(command) + '\n')
  }

  onEvent(listener: BridgeEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: BridgeEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
