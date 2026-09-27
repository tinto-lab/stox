import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Reads/writes the same `~/.config/stox/.env` file stoxlib/config.py
 * already loads for the CLI -- the Settings panel edits this file directly
 * rather than inventing a second storage mechanism, so a key set from the
 * app is immediately visible to the CLI too (and vice versa).
 */
const ENV_PATH = path.join(os.homedir(), '.config', 'stox', '.env')

export function readEnvFile(): Record<string, string> {
  if (!fs.existsSync(ENV_PATH)) return {}
  const result: Record<string, string> = {}
  for (const rawLine of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

/** Merges `values` into the existing file, preserving every other key already there. */
export function writeEnvFile(values: Record<string, string>): void {
  fs.mkdirSync(path.dirname(ENV_PATH), { recursive: true })
  const merged = { ...readEnvFile(), ...values }
  const lines = Object.entries(merged)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${value}`)
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n')
}
