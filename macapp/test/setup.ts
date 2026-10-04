import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import { resetEnvTracking } from '../src/core/config'
import { clearGeoNewsCache } from '../src/core/gnews'

/**
 * Every test gets a throwaway HOME (so ~/.config/stox/ is a temp dir, never
 * the real one) and none of the env vars stox reads -- a developer's own
 * keys or files can't make a test pass or fail.
 */
const STOX_ENV_VARS = [
  'EODHD_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'STOX_LLM_PROVIDER',
  'STOX_LLM_MODEL',
  'STOX_LLM_THINKING'
]

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'stox-test-'))
  vi.stubEnv('HOME', home)
  for (const name of STOX_ENV_VARS) vi.stubEnv(name, undefined)
  resetEnvTracking()
  clearGeoNewsCache()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})
