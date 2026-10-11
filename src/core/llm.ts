import OpenAI from 'openai'
import { writeUserEnv } from './config'

/**
 * The LLM layer: a provider registry (STOX_LLM_PROVIDER / STOX_LLM_MODEL ->
 * a ChatModel), one small provider-neutral message format, and the tool
 * loop the chat agent and the analysis specialists share.
 *
 * Adding a provider means one entry in LLM_PROVIDERS plus, only if it
 * doesn't speak the OpenAI chat API, an adapter -- the agents never change,
 * since they only see ChatModel.
 */

// -- provider-neutral messages --

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/** A tool the model may call; `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface AssistantMessage {
  role: 'assistant'
  text: string
  toolCalls: ToolCall[]
  /** The provider's own content for this turn (e.g. DeepSeek's reasoning),
   * echoed back on the next request to the same provider. */
  raw?: { provider: string; content: unknown }
}

export type ChatMessage =
  | { role: 'user'; text: string }
  | AssistantMessage
  | { role: 'tool'; toolCallId: string; content: string }

export interface CompletionRequest {
  system: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  /** Keep `tools` declared (history may hold calls to them) but forbid new calls. */
  forbidToolUse?: boolean
  /** Receives the model's reasoning as it streams in, where the model
   * exposes it (DeepSeek in thinking mode); otherwise never called. */
  onReasoning?: (delta: string) => void
  /** Receives the reply text as it streams in. A reply that goes on to call
   * tools may have streamed some text first; it's still part of the reply. */
  onText?: (delta: string) => void
  signal?: AbortSignal
}

export interface ChatModel {
  /** '<provider>/<model>', for display. */
  readonly name: string
  complete(request: CompletionRequest): Promise<AssistantMessage>
}

// -- provider registry --

interface ProviderConfig {
  defaultModel: string
  apiKeyEnv: string
  /** Whether thinking can be switched on and off per request (see STOX_LLM_THINKING). */
  thinkingToggle?: boolean
  /** `thinking` is STOX_LLM_THINKING for providers with thinkingToggle, else undefined. */
  build(model: string, apiKey: string, thinking: boolean | undefined): ChatModel
}

export const LLM_PROVIDERS: Record<string, ProviderConfig> = {
  deepseek: {
    defaultModel: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    thinkingToggle: true,
    build: (model, apiKey, thinking) =>
      new OpenAIChatModel('deepseek', model, new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com' }), thinking)
  },
  openai: {
    defaultModel: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    build: (model, apiKey) => new OpenAIChatModel('openai', model, new OpenAI({ apiKey }))
  }
}

/** Raised when the configured provider can't be used. */
export class AgentError extends Error {}

export function currentProviderName(): string {
  return (process.env.STOX_LLM_PROVIDER || 'deepseek').toLowerCase()
}

/** '<provider>/<model>' for whatever's configured -- safe to show even if
 * the provider is unknown or its key is missing. */
export function describeCurrent(): string {
  const provider = currentProviderName()
  const cfg = LLM_PROVIDERS[provider]
  if (!cfg) return provider
  return `${provider}/${process.env.STOX_LLM_MODEL || cfg.defaultModel}`
}

export function providerKeyPresent(): boolean {
  const cfg = LLM_PROVIDERS[currentProviderName()]
  return Boolean(cfg && process.env[cfg.apiKeyEnv])
}

export function thinkingSupported(): boolean {
  return Boolean(LLM_PROVIDERS[currentProviderName()]?.thinkingToggle)
}

/** STOX_LLM_THINKING: on, or off (the default -- faster and cheaper). */
export function thinkingSetting(): boolean {
  return ['on', 'true', '1', 'yes'].includes((process.env.STOX_LLM_THINKING ?? '').trim().toLowerCase())
}

/** Switches thinking for every later request, and saves the choice to
 * ~/.config/stox/.env so the CLI and the app share it. */
export function setThinking(enabled: boolean): void {
  const value = enabled ? 'on' : 'off'
  process.env.STOX_LLM_THINKING = value
  writeUserEnv({ STOX_LLM_THINKING: value })
}

/** A ChatModel for the configured provider; throws AgentError if it can't be used.
 * `thinking` overrides STOX_LLM_THINKING, e.g. off for a quick side task. */
export function buildLLM(options: { thinking?: boolean } = {}): ChatModel {
  const provider = currentProviderName()
  const cfg = LLM_PROVIDERS[provider]
  if (!cfg) {
    throw new AgentError(
      `unknown STOX_LLM_PROVIDER '${provider}' -- choose from: ${Object.keys(LLM_PROVIDERS).join(', ')}`
    )
  }
  const apiKey = process.env[cfg.apiKeyEnv]
  if (!apiKey) throw new AgentError(`no ${cfg.apiKeyEnv} set for provider '${provider}' -- see /help`)
  return cfg.build(
    process.env.STOX_LLM_MODEL || cfg.defaultModel,
    apiKey,
    cfg.thinkingToggle ? (options.thinking ?? thinkingSetting()) : undefined
  )
}

// -- OpenAI-compatible (OpenAI, DeepSeek) --

export class OpenAIChatModel implements ChatModel {
  readonly name: string

  /** `thinking` (DeepSeek only): true/false sends DeepSeek's `thinking`
   * switch with every request; undefined leaves the model's default. */
  constructor(
    private readonly provider: string,
    private readonly model: string,
    private readonly client: OpenAI,
    private readonly thinking?: boolean
  ) {
    this.name = `${provider}/${model}`
  }

  async complete({
    system,
    messages,
    tools,
    forbidToolUse,
    onReasoning,
    onText,
    signal
  }: CompletionRequest): Promise<AssistantMessage> {
    const params = {
      model: this.model,
      messages: [{ role: 'system' as const, content: system }, ...toOpenAIMessages(messages, this.provider)],
      ...(this.thinking === undefined ? {} : { thinking: { type: this.thinking ? 'enabled' : 'disabled' } }),
      ...(tools?.length
        ? {
            tools: tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.parameters }
            })),
            ...(forbidToolUse ? { tool_choice: 'none' as const } : {})
          }
        : {})
    }

    const stream = await this.client.chat.completions.create({ ...params, stream: true }, { signal })
    let text = ''
    let reasoning = ''
    const calls: { id: string; name: string; arguments: string }[] = []
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as
        | (OpenAI.Chat.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string | null })
        | undefined
      if (!delta) continue
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content
        onReasoning?.(delta.reasoning_content)
      }
      if (delta.content) {
        text += delta.content
        onText?.(delta.content)
      }
      // A call's id and name come in its first fragment, the arguments
      // spread over the rest; `index` says which call a fragment belongs to.
      for (const fragment of delta.tool_calls ?? []) {
        const call = (calls[fragment.index] ??= { id: '', name: '', arguments: '' })
        if (fragment.id) call.id = fragment.id
        if (fragment.function?.name) call.name += fragment.function.name
        if (fragment.function?.arguments) call.arguments += fragment.function.arguments
      }
    }
    return this.reply(text, reasoning, calls.filter(Boolean))
  }

  private reply(text: string, reasoning: string, calls: { id: string; name: string; arguments: string }[]): AssistantMessage {
    const toolCalls = calls.map((call): ToolCall => {
      let args: unknown = {}
      try {
        args = JSON.parse(call.arguments || '{}')
      } catch {
        // malformed arguments: run the tool with none, it reports what's missing
      }
      return { id: call.id, name: call.name, args: asArgs(args) }
    })
    // DeepSeek's thinking mode returns the reasoning alongside the answer.
    // With tools in the request it must be sent back on later requests (a
    // 400 otherwise), so it rides along in `raw`.
    return {
      role: 'assistant',
      text,
      toolCalls,
      ...(reasoning ? { raw: { provider: this.provider, content: reasoning } } : {})
    }
  }
}

/** Neutral messages -> chat completions messages. An assistant turn
 * `provider` itself produced gets its reasoning_content back. */
export function toOpenAIMessages(messages: ChatMessage[], provider = 'openai'): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((m): OpenAI.Chat.ChatCompletionMessageParam => {
    if (m.role === 'user') return { role: 'user', content: m.text }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
    return {
      role: 'assistant',
      content: m.text || null,
      ...(m.raw?.provider === provider && typeof m.raw.content === 'string' ? { reasoning_content: m.raw.content } : {}),
      ...(m.toolCalls.length
        ? {
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: JSON.stringify(c.args) }
            }))
          }
        : {})
    }
  })
}

function asArgs(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}

// -- the tool loop --

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
