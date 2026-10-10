/**
 * The chat panel's protocol: commands the renderer sends, and the events a
 * ChatSession (src/core/session.ts, in the main process) answers with over
 * IPC. Shared by main, preload and renderer.
 *
 * Every event carries the id of the command it answers. A command ends with
 * exactly one `result` or `error`; `ask` and `analyze` may send progress
 * events (tool_call, specialist_*, reasoning) before that.
 */

import type { ViewContext } from './types'

export type BridgeCommand =
  | { id: string; cmd: 'ask'; text: string; contexts?: ViewContext[] }
  | { id: string; cmd: 'quote'; tickers: string[] }
  | { id: string; cmd: 'analyze'; ticker: string }
  | { id: string; cmd: 'reset' }
  | { id: string; cmd: 'conversations_list' }
  | { id: string; cmd: 'resume'; conversationId: string }
  | { id: string; cmd: 'considerations_list' }
  | { id: string; cmd: 'considerations_add'; text: string }
  | { id: string; cmd: 'considerations_remove'; text: string }
  | { id: string; cmd: 'status' }
  | { id: string; cmd: 'set_thinking'; enabled: boolean }

interface BridgeEventBase {
  id: string | null
}

export interface ToolCallEvent extends BridgeEventBase {
  type: 'tool_call'
  name: string
  args: Record<string, unknown>
}

export interface SpecialistStartEvent extends BridgeEventBase {
  type: 'specialist_start'
  name: string
}

export interface SpecialistToolCallEvent extends BridgeEventBase {
  type: 'specialist_tool_call'
  agent: string
  name: string
  args: Record<string, unknown>
}

/** A piece of the model's reasoning as it streams in (DeepSeek thinking
 * mode). `agent` is null for the chat agent, else the /analyze stage
 * thinking ("trend", ..., "aggregator"); `step` counts that agent's model
 * calls, so each call's reasoning reads as its own block. Each call opens
 * with an empty delta, marking when it started. */
export interface ReasoningEvent extends BridgeEventBase {
  type: 'reasoning'
  agent: string | null
  step: number
  delta: string
}

/** `data` per command: ask -> AgentResult, analyze -> AnalysisResult,
 * quote -> QuoteResult, considerations_* -> {considerations: string[]},
 * status and set_thinking -> ChatStatus, reset -> {},
 * conversations_list -> {conversations: ConversationSummary[]},
 * resume -> ResumedConversation. */
export interface ResultEvent extends BridgeEventBase {
  type: 'result'
  data: unknown
}

export interface ErrorEvent extends BridgeEventBase {
  type: 'error'
  message: string
}

/** The session was restarted (e.g. Settings changed the provider): requests
 * still in flight will never be answered and should be dropped. `message`
 * is null for a deliberate restart, which isn't worth showing. */
export interface BackendExitEvent {
  id: null
  type: 'backend_exit'
  message: string | null
}

export type BridgeEvent =
  | ToolCallEvent
  | SpecialistStartEvent
  | SpecialistToolCallEvent
  | ReasoningEvent
  | ResultEvent
  | ErrorEvent
  | BackendExitEvent
