import { loadEnv, parseEnvFile, userEnvPath, writeUserEnv } from '../core/config'
import type { Theme } from '../shared/types'
import { handle } from './ipc'
import { getTheme, setTheme } from './preferences'

/** Settings and appearance (see SettingsApi and AppearanceApi). `onSaved`
 * runs after the settings file is written and re-read into the environment. */
export function registerSettingsIpc(projectEnvFile: string | undefined, onSaved: () => void): void {
  handle('settings:read', () => parseEnvFile(userEnvPath()))
  handle('settings:save', (values: Record<string, string>) => {
    writeUserEnv(values)
    loadEnv(projectEnvFile)
    // The provider or model may have changed under a conversation in flight.
    onSaved()
  })
  handle('appearance:get', getTheme)
  handle('appearance:set', (theme: Theme) => setTheme(theme))
}
