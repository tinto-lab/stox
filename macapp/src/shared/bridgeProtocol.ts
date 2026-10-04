/**
 * The chat panel's protocol: commands the renderer sends, and the events a
 * ChatSession (src/core/session.ts, in the main process) answers with over
 * IPC. Shared by main, preload and renderer.
 *
 * Every event carries the id of the command it answers. A command ends with
 * exactly one `result` or `error`; `ask` and `analyze` may send progress
 * events (tool_call, specialist_*) before that.
 */

export type BridgeCommand =
  | { id: string; cmd: 'ask'; text: string }
  | { id: string; cmd: 'quote'; tickers: string[] }
  | { id: string; cmd: 'analyze'; ticker: string }
  | { id: string; cmd: 'reset' }
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

/** `data` per command: ask -> AgentResult, analyze -> AnalysisResult,
 * quote -> QuoteResult, considerations_* -> {considerations: string[]},
 * status and set_thinking -> ChatStatus, reset -> {}. */
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
  | ResultEvent
  | ErrorEvent
  | BackendExitEvent
