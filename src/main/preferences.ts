import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { nativeTheme } from 'electron'
import { THEMES, VOICE_LANGUAGES, type Theme, type VoiceLanguage } from '../shared/types'

/**
 * App-only preferences (the light/dark choice and the dictation language), persisted in
 * ~/.config/stox/ alongside the watchlist and .env. Unlike .env these are
 * never read by the terminal CLI.
 */
const PREFERENCES_PATH = path.join(os.homedir(), '.config', 'stox', 'preferences.json')

interface Preferences {
  theme: Theme
  voiceLanguage: VoiceLanguage
}

const DEFAULTS: Preferences = { theme: 'system', voiceLanguage: 'auto' }

function readPreferences(): Preferences {
  try {
    const parsed = JSON.parse(fs.readFileSync(PREFERENCES_PATH, 'utf8')) as { theme?: unknown; voiceLanguage?: unknown }
    return {
      theme: THEMES.find((t) => t === parsed.theme) ?? DEFAULTS.theme,
      voiceLanguage: VOICE_LANGUAGES.find((l) => l.code === parsed.voiceLanguage)?.code ?? DEFAULTS.voiceLanguage
    }
  } catch {
    return DEFAULTS // no file yet, or unreadable -- fall back to defaults
  }
}

function writePreferences(prefs: Preferences): void {
  fs.mkdirSync(path.dirname(PREFERENCES_PATH), { recursive: true })
  // Write-then-rename, so quitting mid-write can't leave a half-written file.
  const tmp = `${PREFERENCES_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2) + '\n')
  fs.renameSync(tmp, PREFERENCES_PATH)
}

export function getTheme(): Theme {
  return readPreferences().theme
}

/** Applies the theme app-wide: nativeTheme drives the renderer's
 * `prefers-color-scheme` (which styles.css keys off) as well as native
 * controls, scrollbars and the title bar, so no reload is needed. */
export function applyTheme(theme: Theme): void {
  nativeTheme.themeSource = theme
}

export function setTheme(theme: Theme): void {
  if (!THEMES.includes(theme)) throw new Error(`unknown theme: ${theme}`)
  applyTheme(theme)
  writePreferences({ ...readPreferences(), theme })
}

export function getVoiceLanguage(): VoiceLanguage {
  return readPreferences().voiceLanguage
}

export function setVoiceLanguage(voiceLanguage: VoiceLanguage): void {
  if (!VOICE_LANGUAGES.some((l) => l.code === voiceLanguage)) throw new Error(`unknown language: ${voiceLanguage}`)
  writePreferences({ ...readPreferences(), voiceLanguage })
}
