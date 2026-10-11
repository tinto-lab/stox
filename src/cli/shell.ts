import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { inspect } from 'node:util'
import { askAgent, recordAnalysis } from '../core/agent'
import { runStockAnalysis } from '../core/analysis'
import { configDir } from '../core/config'
import { Conversation, type Titler, conversationsDir, listConversations, modelTitler } from '../core/conversations'
import {
  type ChatModel,
  buildLLM,
  currentProviderName,
  describeCurrent,
  providerKeyPresent,
  setThinking,
  thinkingSetting,
  thinkingSupported
} from '../core/llm'
import { hasEodhdKey } from '../core/marketData'
import { type Services, defaultServices } from '../core/services'
import { normalize } from '../shared/symbols'
import { ReasoningPrinter } from './reasoning'
import { bold, dim, panel, showAnalysis, showQuotes, showResultData, style } from './render'

/**
 * The REPL: reads a line, routes it, prints the result. Routing is
 * deliberately trivial -- a slash command is handled here, everything else
 * goes to the agent, which decides what's actually needed (a price only,
 * or news/history/fundamentals/a full analysis). /price is the one local
 * shortcut, for an instant, LLM-free quote.
 */

const BANNER =
  `${bold('stox')} · research console\n` +
  dim('ask about a stock, in any language -- or /price AAPL for an instant quote · /help · /quit')

const HELP = `${bold('commands')}
  <anything>       ask about a stock, in any language -- the agent decides
                   what you actually need:
                     AAPL  or  what's apple trading at?   -> just the price
                     any news on tesla?                   -> price + news
                     how has tesla done this month?       -> price history
                     should I buy apple? / assess the risk -> full /analyze
                   the agent remembers this session -- follow-ups like
                   "what about its news?" and "read that first one in
                   full" work, /analyze results included; "always factor in
                   insider selling when you explain price moves" saves a
                   standing note; every conversation is saved -- pick
                   one up later with /resume
  /price <ticker> [...]  instant quote(s), no LLM involved:
                         AAPL   or   TSLA MSFT NVDA
  /analyze <ticker>  trend, fundamentals, news, and geopolitics specialist
                     agents for one ticker, then an aggregator's risk
                     assessment -- several LLM calls, slower than a question
  /help            this message
  /clear           clear the screen
  /reset           forget the conversation so far (also /new)
  /resume [n]      list saved conversations, or pick up number n where it
                   left off (launch with stox --continue for the latest)
  /considerations  list standing factors the agent always weighs (also /remembered)
  /think [on|off]  show or switch thinking mode (DeepSeek) -- deeper answers,
                   but slower; saved for next time, shared with the app
  /quit  /exit     leave
  ctrl+c           cancel a running question, or leave at the prompt

${bold('tickers')}
  bare symbols default to .US (AAPL -> AAPL.US)
  add the exchange for anything else:
    BMW.XETRA   BTC-USD.CC   EURUSD.FOREX

${bold('setup')}
  keys go in ~/.config/stox/.env (the app's Settings panel edits the same
  file) or a .env at the repo root -- see .env.example.

  EODHD_API_KEY=demo   -> test AAPL.US TSLA.US VTI.US
                          AMZN.US BTC-USD.CC EURUSD.FOREX
  or a free key from eodhd.com (20 calls/day). Powers quotes, news, and
  price history. Fundamentals come from Yahoo Finance and world news from
  Google News -- both free and keyless.

  everything except /price needs an LLM provider:
    STOX_LLM_PROVIDER=deepseek|openai  (default: deepseek)
    STOX_LLM_MODEL=...     optional, each provider has a default
    DEEPSEEK_API_KEY=...  or OPENAI_API_KEY
    STOX_LLM_THINKING=on|off  DeepSeek thinking mode (default: off), or /think

  standing considerations persist to ~/.config/stox/considerations.txt --
  plain text, one per line, safe to hand-edit or delete. conversations are
  saved to ~/.config/stox/conversations/ (questions you asked and their
  answers, not /analyze or /price) -- plain JSON, safe to delete.`

const HISTORY_SIZE = 1000
const RESUME_LIST_SIZE = 10
const RECAP_TURNS = 5

const print = (text = ''): void => {
  process.stdout.write(text + '\n')
}
const fail = (message: string): void => print(`${style('red', '✗')} ${message}`)
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${inspect(v, { breakLength: Infinity })}`)
    .join(', ')
}

// Tool-call lines are dimmed as a whole: args trace back through the model,
// which may have read external text, so they're never parsed for styling.
const toolCallLine = (name: string, args: Record<string, unknown>): string => dim(`  ↳ ${name}(${formatArgs(args)})`)
const specialistToolCallLine = (agent: string, name: string, args: Record<string, unknown>): string =>
  dim(`  ↳ [${agent}] ${name}(${formatArgs(args)})`)
const agentStartLine = (name: string): string => dim(`→ ${name} agent`)

/** Progress callbacks for /analyze's specialists, printed through `out` so
 * their lines and reasoning blocks never land mid-way through a stream. */
function analysisProgress(out: ReasoningPrinter) {
  return {
    onAgentStart: (name: string) => {
      // The aggregator starts once every specialist is done: print what they thought first.
      if (name === 'aggregator') out.flush()
      out.line(agentStartLine(name))
    },
    onToolCall: (agent: string, name: string, args: Record<string, unknown>) => {
      out.flush(agent)
      out.line(specialistToolCallLine(agent, name, args))
    },
    onReasoningStep: (agent: string) => out.agentStep(agent),
    onReasoning: (agent: string, delta: string) => out.agentDelta(agent, delta)
  }
}

/** "5m ago", "3h ago", "2d ago", else the date. */
function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h ago`
  if (minutes < 7 * 24 * 60) return `${Math.round(minutes / (24 * 60))}d ago`
  return iso.slice(0, 10)
}

export class Shell {
  private conversation = new Conversation()
  // The question or analysis in flight, so ctrl+c can cancel it.
  private running: AbortController | null = null
  // Saves still being written (a new conversation's first waits on its title).
  private saving: Promise<unknown> = Promise.resolve()
  private readonly titler: Titler
  private readonly services: Services
  private readonly buildModel: () => ChatModel

  /** `titler` names each new conversation, `services` is the data and
   * storage the agents use, `buildModel` makes the model for each question;
   * tests pass stand-ins. */
  constructor(options: { titler?: Titler; services?: Services; buildModel?: () => ChatModel } = {}) {
    this.titler = options.titler ?? modelTitler
    this.services = options.services ?? defaultServices
    this.buildModel = options.buildModel ?? buildLLM
  }

  /** Waits for saves still in progress, e.g. before exiting. */
  async flush(): Promise<void> {
    await this.saving
  }

  async handleLine(line: string): Promise<boolean> {
    if (line.startsWith('/')) return this.handleCommand(line)
    await this.handleQuery(line)
    return true
  }

  /** Returns false when the user asked to leave. */
  async handleCommand(line: string): Promise<boolean> {
    const [word, ...rest] = line.split(/\s+/)
    switch (word.toLowerCase()) {
      case '/quit':
      case '/exit':
      case '/q':
        print(dim('bye.'))
        return false
      case '/help':
        print(panel(HELP, 'help'))
        break
      case '/clear':
        process.stdout.write('\x1b[2J\x1b[H')
        print(panel(BANNER, 'stox', 'cyan'))
        break
      case '/reset':
      case '/new':
        this.conversation = new Conversation()
        print(dim('starting a new conversation -- the last one is saved, see /resume.'))
        break
      case '/resume':
        await this.handleResume(rest[0])
        break
      case '/considerations':
      case '/remembered':
        this.showConsiderations()
        break
      case '/think':
        this.handleThink(rest[0])
        break
      case '/analyze':
        if (!rest[0]) print(`${style('red', 'usage:')} /analyze <ticker>`)
        else await this.handleAnalyze(rest[0])
        break
      case '/price':
        if (!rest.length) print(`${style('red', 'usage:')} /price <ticker> [...]`)
        else await this.handlePrice(rest)
        break
      default:
        print(`${style('red', 'unknown command:')} ${word}  ${dim('(try /help)')}`)
    }
    return true
  }

  /** Cancels the question in flight; false if there wasn't one. */
  cancel(): boolean {
    if (!this.running) return false
    this.running.abort()
    return true
  }

  /** Picks up the latest saved conversation, e.g. for `stox --continue`. */
  resumeLatest(): void {
    const latest = Conversation.latest()
    if (!latest) {
      print(dim('no saved conversations yet -- starting a new one.'))
      return
    }
    this.resume(latest)
  }

  /** No argument: lists the saved conversations; a number: resumes that one. */
  private async handleResume(arg?: string): Promise<void> {
    await this.flush() // so the list includes the conversation just had
    const saved = listConversations(RESUME_LIST_SIZE)
    if (!arg) {
      if (!saved.length) {
        print(dim('no saved conversations yet -- ask something and it will be.'))
        return
      }
      print(dim(`saved conversations (${conversationsDir()}):`))
      saved.forEach((c, i) => {
        const turns = `${c.turnCount} question${c.turnCount === 1 ? '' : 's'}`
        print(`  ${bold(String(i + 1).padStart(2))}  ${c.title}  ${dim(`· ${ago(c.updatedAt)} · ${turns}`)}`)
      })
      print(dim('resume one with /resume <number>'))
      return
    }
    const n = Number(arg)
    if (!Number.isInteger(n) || n < 1 || n > saved.length) {
      print(`${style('red', 'usage:')} /resume <number> ${dim('(see /resume for the list)')}`)
      return
    }
    try {
      this.resume(Conversation.resume(saved[n - 1].id))
    } catch (e) {
      fail(errorMessage(e))
    }
  }

  /** Switches to `conversation` and recaps its last few turns -- text only:
   * the data panels it showed then would be stale now. */
  private resume(conversation: Conversation): void {
    this.conversation = conversation
    const { title, updatedAt } = conversation.summary
    print(dim(`resumed "${title}" · last answered ${ago(updatedAt)}`))
    const recap = conversation.turns.slice(-RECAP_TURNS)
    const earlier = conversation.turns.length - recap.length
    if (earlier) print(dim(`  … ${earlier} earlier question${earlier === 1 ? '' : 's'}`))
    for (const turn of recap) {
      print(dim(`› ${turn.text}`))
      if (turn.result.text) print(turn.result.text)
    }
    print()
  }

  /** Thinking applies from the next question on; the conversation carries on. */
  private handleThink(arg?: string): void {
    if (!thinkingSupported()) {
      print(dim(`thinking mode can't be switched for provider '${currentProviderName()}' -- only for deepseek.`))
      return
    }
    const choice = arg?.toLowerCase()
    if (choice === 'on' || choice === 'off') setThinking(choice === 'on')
    else if (choice) {
      print(`${style('red', 'usage:')} /think [on|off]`)
      return
    }
    print(dim(`thinking mode: ${thinkingSetting() ? 'on' : 'off'}`))
  }

  private showConsiderations(): void {
    const items = this.services.considerations.list()
    if (!items.length) {
      print(
        dim(
          `no standing considerations yet -- tell the agent to always factor something in, or edit ${this.services.considerations.location} directly.`
        )
      )
      return
    }
    print(dim(`standing considerations (${this.services.considerations.location}):`))
    for (const item of items) print(`  - ${item}`)
  }

  private async handlePrice(tickers: string[]): Promise<void> {
    print(dim(`→ quote · ${tickers.map(normalize).join(', ')}`))
    try {
      const { quotes, missing } = await this.services.market.quotes(tickers)
      for (const code of missing) print(`${style('red', `✗ ${code}:`)} no data (unknown symbol?)`)
      if (quotes.length) print(showQuotes(quotes))
    } catch (e) {
      fail(errorMessage(e))
    }
  }

  private async handleQuery(text: string): Promise<void> {
    print(dim(`→ agent (${describeCurrent()}) · ${text}`))
    const out = new ReasoningPrinter()
    const analysis = analysisProgress(out)
    const conversation = this.conversation
    const result = await this.cancellable(
      (signal) =>
        askAgent(this.buildModel(), text, conversation.history, {
        signal,
        onToolCall: (name, args) => out.line(toolCallLine(name, args)),
        onReasoningStep: () => out.step(),
        onReasoning: (delta) => out.delta(delta),
        onText: (delta) => out.text(delta),
        onAnalysisAgentStart: analysis.onAgentStart,
        onAnalysisToolCall: analysis.onToolCall,
        onAnalysisReasoningStep: analysis.onReasoningStep,
        onAnalysisReasoning: analysis.onReasoning
      }, this.services),
      out
    )
    if (!result) return
    if (result.text && !out.streamedAnswer) print(result.text)
    print()
    const data = showResultData(result)
    if (data) print(data)
    if (result.analysis) print(showAnalysis(result.analysis))
    // Not awaited: the prompt comes back while a new conversation is named.
    const saved = conversation.recordAsk(text, result, this.titler).catch((e) => {
      fail(`couldn't save the conversation: ${errorMessage(e)}`)
    })
    this.saving = Promise.all([this.saving, saved])
  }

  private async handleAnalyze(ticker: string): Promise<void> {
    const code = normalize(ticker)
    print(
      dim(
        `→ analyzing ${code} · trend, fundamentals, news, and geopolitics run concurrently, then an aggregator · please wait`
      )
    )
    const out = new ReasoningPrinter()
    const result = await this.cancellable(
      (signal) => runStockAnalysis(this.buildModel(), ticker, { signal, ...analysisProgress(out) }, this.services),
      out
    )
    if (!result) return
    print()
    const data = showResultData(result)
    if (data) print(data)
    print(showAnalysis(result))
    recordAnalysis(this.conversation.history, code, result)
  }

  /** Runs `fn`, printing its failure; null if it failed or was cancelled.
   * `out`'s open reasoning is closed off before anything else is printed. */
  private async cancellable<T>(fn: (signal: AbortSignal) => Promise<T>, out?: ReasoningPrinter): Promise<T | null> {
    const controller = new AbortController()
    this.running = controller
    try {
      const result = await fn(controller.signal)
      out?.end()
      return result
    } catch (e) {
      out?.end()
      if (controller.signal.aborted) print(dim('cancelled.'))
      else fail(errorMessage(e))
      return null
    } finally {
      this.running = null
    }
  }
}

function historyPath(): string {
  return path.join(configDir(), 'history')
}

function loadLineHistory(): string[] {
  try {
    // readline wants newest first
    return fs.readFileSync(historyPath(), 'utf8').split('\n').filter(Boolean).reverse().slice(0, HISTORY_SIZE)
  } catch {
    return []
  }
}

function saveLineHistory(lines: string[]): void {
  try {
    fs.mkdirSync(configDir(), { recursive: true })
    fs.writeFileSync(historyPath(), [...lines].reverse().join('\n') + '\n')
  } catch {
    // best effort
  }
}

export async function runRepl(options: { continueLatest?: boolean } = {}): Promise<void> {
  print(panel(BANNER, 'stox', 'cyan'))
  if (!hasEodhdKey()) print(`${style('yellow', '!')} no EODHD_API_KEY set -- see ${bold('/help')}.\n`)
  if (!providerKeyPresent()) {
    print(`${style('yellow', '!')} no LLM provider configured -- plain-English questions won't work -- see ${bold('/help')}.\n`)
  } else {
    const thinking = thinkingSupported() ? ` · thinking ${thinkingSetting() ? 'on' : 'off'} (/think)` : ''
    print(dim(`LLM provider: ${describeCurrent()}${thinking}`) + '\n')
  }

  const shell = new Shell()
  if (options.continueLatest) shell.resumeLatest()
  let lineHistory = loadLineHistory()
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    history: lineHistory,
    historySize: HISTORY_SIZE,
    removeHistoryDuplicates: true
  })
  rl.on('history', (history: string[]) => {
    lineHistory = history
  })
  rl.setPrompt(style(['bold', 'cyan'], '› '))

  // ctrl+c cancels a running question; at the prompt it leaves.
  rl.on('SIGINT', () => {
    if (shell.cancel()) return
    print('\n' + dim('bye.'))
    rl.close()
  })

  // Piped input can end while a line is still being handled; lines already
  // read are still delivered, there's just no prompt to show for them.
  let closed = false
  rl.once('close', () => {
    closed = true
  })

  rl.prompt()
  for await (const raw of rl) {
    const line = raw.trim()
    if (line && !(await shell.handleLine(line))) break
    if (!closed) rl.prompt()
  }
  rl.close()
  saveLineHistory(lineHistory)
  await shell.flush()
}
