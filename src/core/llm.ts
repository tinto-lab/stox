/**
 * The LLM layer: one small provider-neutral message format (llmTypes), the
 * provider registry (providers) with its OpenAI-compatible adapter
 * (openai), and the tool loop the chat agent and the analysis specialists
 * share (toolLoop). This is the one place the rest of the app imports it from.
 */
export * from './llmTypes'
export * from './providers'
export { OpenAIChatModel, toOpenAIMessages } from './openai'
export * from './toolLoop'
