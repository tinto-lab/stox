import type { ServerState } from '../../../shared/types'

export const SERVER_LABELS: Record<ServerState, string> = {
  stopped: 'Stopped',
  starting: 'Starting…',
  running: 'Running'
}

/** A status light: green when the speech engine is running, amber while
 * it starts, grey when it's stopped. */
export function ServerDot({ state }: { state: ServerState }) {
  return <span className={`server-dot ${state}`} role="img" aria-label={`Speech engine ${SERVER_LABELS[state].toLowerCase()}`} />
}
