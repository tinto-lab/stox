import { ipcMain } from 'electron'
import type { IpcResult } from '../shared/types'

/** Registers an IPC handler whose failures come back as {ok: false, error}
 * (see IpcResult) rather than as a rejected invoke. */
export function handle<A extends unknown[], T>(channel: string, fn: (...args: A) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResult<T>> => {
    try {
      return { ok: true, data: await fn(...(args as A)) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}
