/**
 * Wire protocol for the chat panel's Python backend, stoxlib/bridge.py (see
 * that module's docstring for the authoritative description). Kept in sync
 * with the Python side by hand; shared by main, preload and renderer.
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

export interface ResultEvent extends BridgeEventBase {
  type: 'result'
  data: unknown
}

export interface ErrorEvent extends BridgeEventBase {
  type: 'error'
  message: string
}

/** Not sent by the Python side: synthesized by the main process's
 * BridgeProcess when the backend process ends, so requests still in flight
 * can be dropped. `message` is null when it was stopped deliberately. */
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
