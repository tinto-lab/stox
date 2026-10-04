import type { BridgeCommand, BridgeEvent } from '../shared/bridgeProtocol'
import type { ChatStatus } from '../shared/types'
import { normalize } from '../shared/symbols'
import { askAgent, recordAnalysis } from './agent'
import { runStockAnalysis } from './analysis'
import { addConsideration, loadConsiderations, removeConsideration } from './considerations'
import {
  type ChatMessage,
  buildLLM,
  currentProviderName,
  describeCurrent,
  providerKeyPresent,
  setThinking,
  thinkingSetting,
  thinkingSupported
} from './llm'
import { fetchQuotes, hasEodhdKey } from './marketData'

/**
 * One chat conversation, driven by BridgeCommands and answering with
 * BridgeEvents (see shared/bridgeProtocol.ts) -- the chat panel's backend,
 * run in the app's main process.
 *
 * Commands that read or change the conversation (ask, analyze, reset) run
 * one at a time, in order, so two quick questions can't interleave their
 * turns in the history; the rest answer immediately.
 */
export class ChatSession {
  private history: ChatMessage[] = []
  private queue: Promise<void> = Promise.resolve()
  private abort = new AbortController()

  constructor(private readonly emit: (event: BridgeEvent) => void) {}

  handle(command: BridgeCommand): void {
    // Captured now, not when the command starts: one still queued at a
    // restart() belongs to the abandoned conversation.
    const signal = this.abort.signal
    const run = (): Promise<void> =>
      signal.aborted ? Promise.resolve() : this.run(command, signal).catch((e) => {
            // Aborted by restart(): nobody's waiting for this one any more.
            if (!signal.aborted) this.emit({ id: command.id, type: 'error', message: errorMessage(e) })
          })
    if (command.cmd === 'ask' || command.cmd === 'analyze' || command.cmd === 'reset') {
      this.queue = this.queue.then(run)
    } else {
      void run()
    }
  }

  /** Abandons whatever is in flight and starts a fresh conversation, e.g.
   * after Settings change the provider. Requests in flight get no answer;
   * a backend_exit event tells the renderer to stop waiting for them. */
  restart(): void {
    this.abort.abort()
    this.abort = new AbortController()
    this.history = []
    this.queue = Promise.resolve()
    this.emit({ id: null, type: 'backend_exit', message: null })
  }

  private async run(command: BridgeCommand, signal: AbortSignal): Promise<void> {
    const { id } = command
    // Results for a request abandoned by restart() are dropped, not delivered late.
    const result = (data: unknown): void => {
      if (!signal.aborted) this.emit({ id, type: 'result', data })
    }

    // Each agent's model calls are numbered, so the UI can start a fresh
    // reasoning block per call. With thinking on, an empty delta marks the
    // call's start, so the UI can time the thinking from there.
    const thinking = thinkingSupported() && thinkingSetting()
    const steps = new Map<string | null, number>()
    const reasoningStep = (agent: string | null): void => {
      steps.set(agent, (steps.get(agent) ?? 0) + 1)
      if (thinking) reasoning(agent, '')
    }
    const reasoning = (agent: string | null, delta: string): void => {
      if (!signal.aborted) this.emit({ id, type: 'reasoning', agent, step: steps.get(agent) ?? 1, delta })
    }

    switch (command.cmd) {
      case 'ask': {
        const data = await askAgent(buildLLM(), command.text, this.history, {
          signal,
          onToolCall: (name, args) => this.emit({ id, type: 'tool_call', name, args }),
          onAnalysisAgentStart: (name) => this.emit({ id, type: 'specialist_start', name }),
          onAnalysisToolCall: (agent, name, args) => this.emit({ id, type: 'specialist_tool_call', agent, name, args }),
          onReasoningStep: () => reasoningStep(null),
          onReasoning: (delta) => reasoning(null, delta),
          onAnalysisReasoningStep: reasoningStep,
          onAnalysisReasoning: reasoning
        })
        return result(data)
      }
      case 'analyze': {
        const data = await runStockAnalysis(buildLLM(), command.ticker, {
          signal,
          onAgentStart: (name) => this.emit({ id, type: 'specialist_start', name }),
          onToolCall: (agent, name, args) => this.emit({ id, type: 'specialist_tool_call', agent, name, args }),
          onReasoningStep: reasoningStep,
          onReasoning: reasoning
        })
        if (signal.aborted) return
        recordAnalysis(this.history, normalize(command.ticker), data)
        return result(data)
      }
      case 'quote':
        return result(await fetchQuotes(command.tickers))
      case 'reset':
        this.history = []
        return result({})
      case 'considerations_list':
        return result({ considerations: loadConsiderations() })
      case 'considerations_add':
        addConsideration(command.text)
        return result({ considerations: loadConsiderations() })
      case 'considerations_remove':
        return result({ considerations: removeConsideration(command.text) })
      case 'status':
        return result(chatStatus())
      case 'set_thinking':
        // Applies from the next model call; the conversation carries on.
        if (thinkingSupported()) setThinking(command.enabled)
        return result(chatStatus())
      default:
        this.emit({ id, type: 'error', message: `unknown command: ${(command as { cmd: string }).cmd}` })
    }
  }
}

function chatStatus(): ChatStatus {
  return {
    eodhdKey: hasEodhdKey(),
    provider: currentProviderName(),
    model: describeCurrent(),
    providerKeyPresent: providerKeyPresent(),
    thinking: thinkingSupported() ? thinkingSetting() : null
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
