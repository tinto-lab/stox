import { dim, terminalWidth, wrap } from './render'

const INDENT = '  '

function seconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}s`
}

/**
 * Prints the model's reasoning (DeepSeek thinking mode) in the terminal.
 *
 * The chat agent's reasoning streams live, dimmed and word-wrapped, under a
 * "thinking…" label. The /analyze specialists think concurrently, so
 * streaming them would interleave mid-line; each one's reasoning is
 * buffered instead and printed as a labelled block ("[trend] thought 6s:
 * …") when that model call moves on.
 *
 * Anything else printed while a stream is open must go through line(), so
 * the stream is closed off first.
 */
export class ReasoningPrinter {
  private column = 0
  private streaming = false
  private answered = false
  private textOpen = false
  // Timed from the model call's start to its last delta: how long it spent
  // reasoning, not how long until something else got printed.
  private readonly buffers = new Map<string, { text: string; startedAt: number; lastAt: number }>()

  constructor(private readonly write: (text: string) => void = (text) => process.stdout.write(text)) {}

  /** A new model call for the chat agent: its reasoning starts a fresh block. */
  step(): void {
    this.endStream()
  }

  delta(text: string): void {
    const width = Math.max(20, terminalWidth() - INDENT.length)
    if (!this.streaming) {
      this.write(dim(`${INDENT}thinking… `))
      this.column = 'thinking… '.length
      this.streaming = true
    }
    // Word-wrap as the text arrives: break before a word that would run past the edge.
    for (const piece of text.split(/(\s+)/)) {
      if (!piece) continue
      if (/^\s+$/.test(piece)) {
        if (piece.includes('\n')) this.newline()
        else if (this.column > 0) {
          this.write(' ')
          this.column++
        }
        continue
      }
      if (this.column > 0 && this.column + piece.length > width) this.newline()
      this.write(dim(piece))
      this.column += piece.length
    }
  }

  /** A piece of the chat agent's answer, printed as it arrives. */
  text(text: string): void {
    if (this.streaming) this.endStream()
    this.answered = true
    this.textOpen = true
    this.write(text)
  }

  /** Whether any answer text was streamed (so it needn't be printed again). */
  get streamedAnswer(): boolean {
    return this.answered
  }

  /** A new model call for a specialist: prints its previous call's block. */
  agentStep(agent: string): void {
    this.flush(agent)
    const now = Date.now()
    this.buffers.set(agent, { text: '', startedAt: now, lastAt: now })
  }

  agentDelta(agent: string, text: string): void {
    const now = Date.now()
    const buffer = this.buffers.get(agent) ?? { text: '', startedAt: now, lastAt: now }
    buffer.text += text
    buffer.lastAt = now
    this.buffers.set(agent, buffer)
  }

  /** Prints `agent`'s buffered reasoning (or everyone's) as labelled blocks. */
  flush(agent?: string): void {
    for (const [name, buffer] of [...this.buffers]) {
      if (agent !== undefined && name !== agent) continue
      this.buffers.delete(name)
      const text = buffer.text.trim()
      if (!text) continue
      this.endStream()
      const label = `[${name}] thought ${seconds(buffer.lastAt - buffer.startedAt)}: `
      const lines = wrap(label + text.replace(/\s+/g, ' '), Math.max(20, terminalWidth() - INDENT.length * 2))
      this.write(lines.map((l, i) => dim(`${i ? INDENT + INDENT : INDENT}${l}`)).join('\n') + '\n')
    }
  }

  /** Prints a line of other output, closing an open stream first. */
  line(text: string): void {
    this.endStream()
    this.write(text + '\n')
  }

  /** Closes everything off: the stream, and any specialist still buffered. */
  end(): void {
    this.endStream()
    this.flush()
  }

  private endStream(): void {
    if (this.textOpen) {
      this.write('\n')
      this.textOpen = false
    }
    if (!this.streaming) return
    this.write('\n')
    this.streaming = false
    this.column = 0
  }

  private newline(): void {
    this.write(`\n${INDENT}`)
    this.column = 0
  }
}
