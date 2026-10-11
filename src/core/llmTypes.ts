/** The provider-neutral vocabulary the agents and every model adapter share. */

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
