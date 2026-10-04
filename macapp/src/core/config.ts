import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Where all of stox's user state lives (~/.config/stox/): the .env file the
 * Settings panel edits, considerations, monitors, the watchlist, ...
 *
 * A function, not a constant, so it follows HOME -- tests point HOME at a
 * throwaway directory instead of touching the real one.
 */
export function configDir(): string {
  return path.join(os.homedir(), '.config', 'stox')
}

export function userEnvPath(): string {
  return path.join(configDir(), '.env')
}

/** Parses a .env file into key/value pairs; a missing file is just empty. */
export function parseEnvFile(file: string): Record<string, string> {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  const result: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    let line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice('export '.length)
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    } else {
      const comment = value.search(/\s#/)
      if (comment !== -1) value = value.slice(0, comment).trimEnd()
    }
    if (key) result[key] = value
  }
  return result
}

// Keys that were in the environment before any file was loaded: a real
// `export`ed variable always wins over the files, on every reload too.
let exportedKeys: Set<string> | null = null
// Keys a previous loadEnv() filled in from a file, so a reload can drop the
// ones that have since been removed from it.
let fileKeys = new Set<string>()

/**
 * Fills process.env from .env files, without overriding real exported
 * variables. Checked in order, the first file to set a key winning:
 *
 *     <project root>/.env   project-local (dev checkouts only), passed in
 *     ~/.config/stox/.env   user-wide -- what the Settings panel edits
 *
 * Safe to call again after a file changes (e.g. Settings saved): values
 * from the files are re-read, removed keys are dropped.
 */
export function loadEnv(projectEnvFile?: string): void {
  exportedKeys ??= new Set(Object.keys(process.env))
  const merged = { ...parseEnvFile(userEnvPath()), ...(projectEnvFile ? parseEnvFile(projectEnvFile) : {}) }
  for (const key of fileKeys) {
    if (!(key in merged)) delete process.env[key]
  }
  fileKeys = new Set()
  for (const [key, value] of Object.entries(merged)) {
    if (exportedKeys.has(key)) continue
    process.env[key] = value
    fileKeys.add(key)
  }
}

/** Test hook: forget what loadEnv() has seen, so each test starts clean. */
export function resetEnvTracking(): void {
  exportedKeys = null
  fileKeys = new Set()
}

/** Merges `values` into the user-wide .env file, preserving every other key there. */
export function writeUserEnv(values: Record<string, string>): void {
  const file = userEnvPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const merged = { ...parseEnvFile(file), ...values }
  const lines = Object.entries(merged)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${value}`)
  fs.writeFileSync(file, lines.join('\n') + '\n')
}

/** Whole-file JSON write via write-then-rename, so a reader never sees half a file. */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

export function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}
