import fs from 'node:fs'
import path from 'node:path'
import { configDir } from './config'

/**
 * Standing considerations: factors the user has asked the agent to always
 * weigh when explaining a price move or assessing risk. Unlike the chat's
 * conversation history (in memory, one session), these live on disk --
 * plain text, one per line, fine to hand-edit -- so they apply in every
 * future session too.
 */

export function considerationsPath(): string {
  return path.join(configDir(), 'considerations.txt')
}

/** The stored considerations; blank lines and '#' comments are skipped. */
export function loadConsiderations(): string[] {
  let text: string
  try {
    text = fs.readFileSync(considerationsPath(), 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

/** Appends a consideration, skipping an exact duplicate. */
export function addConsideration(text: string): void {
  const item = text.trim()
  if (!item || loadConsiderations().includes(item)) return
  fs.mkdirSync(configDir(), { recursive: true })
  fs.appendFileSync(considerationsPath(), item + '\n')
}

/** Removes a consideration; returns what's left. Hand-written comments go
 * with the rewrite -- it's the stored list that matters. */
export function removeConsideration(text: string): string[] {
  const target = text.trim()
  const remaining = loadConsiderations().filter((c) => c !== target)
  fs.mkdirSync(configDir(), { recursive: true })
  fs.writeFileSync(considerationsPath(), remaining.map((c) => c + '\n').join(''))
  return remaining
}
