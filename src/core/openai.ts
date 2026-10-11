import OpenAI from 'openai'
import type { AssistantMessage, ChatMessage, ChatModel, CompletionRequest, ToolCall } from './llmTypes'

/** The OpenAI chat-completions adapter, used for OpenAI itself and for DeepSeek. */

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
