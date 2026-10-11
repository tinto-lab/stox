import type { ChatMessage, ChatModel, ToolSpec } from './llmTypes'

export type Dispatch = (name: string, args: Record<string, unknown>) => Promise<string>
export type OnToolCall = (name: string, args: Record<string, unknown>) => void

export interface ToolLoopOptions {
  llm: ChatModel
  system: string
  /** The conversation so far, ending in the user's message; extended in place. */
  messages: ChatMessage[]
  tools: ToolSpec[]
  dispatch: Dispatch
  /** Called right before each tool runs, for visibility into what the model is doing. */
  onToolCall?: OnToolCall
  /** Called right before each model call, so a UI can start a fresh
   * reasoning block for it. */
  onStep?: () => void
  /** The model's reasoning as it streams in (see CompletionRequest). */
  onReasoning?: (delta: string) => void
  /** The reply text as it streams in (see CompletionRequest). */
  onText?: (delta: string) => void
  /** Unset: loop until the model stops calling tools. Set: after that many
   * model calls, append `budgetExhaustedNotice` and make one last call with
   * tool use forbidden, so the model writes up what it has instead of nothing. */
  maxRounds?: number
  budgetExhaustedNotice?: string
  signal?: AbortSignal
}

/**
 * Call the model; if it called tools, run them (concurrently -- they're
 * independent lookups) through `dispatch`, append the results, and go
 * again. Returns the model's final text.
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<string> {
  const { llm, system, messages, tools, dispatch, onToolCall, onStep, onReasoning, onText, maxRounds, signal } = options

  for (let round = 0; maxRounds === undefined || round < maxRounds; round++) {
    signal?.throwIfAborted()
    onStep?.()
    const reply = await llm.complete({ system, messages, tools, onReasoning, onText, signal })
    messages.push(reply)
    if (!reply.toolCalls.length) return reply.text

    const results = await Promise.all(
      reply.toolCalls.map((call) => {
        onToolCall?.(call.name, call.args)
        return dispatch(call.name, call.args)
      })
    )
    reply.toolCalls.forEach((call, i) => messages.push({ role: 'tool', toolCallId: call.id, content: results[i] }))
  }

  messages.push({ role: 'user', text: options.budgetExhaustedNotice ?? 'Answer now with what you have.' })
  signal?.throwIfAborted()
  onStep?.()
  const final = await llm.complete({ system, messages, tools, forbidToolUse: true, onReasoning, onText, signal })
  messages.push(final)
  return final.text
}
