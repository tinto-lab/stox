import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { configDir, loadEnv, parseEnvFile, userEnvPath, writeUserEnv } from '../src/core/config'
import { addConsideration, considerationsPath, loadConsiderations, removeConsideration } from '../src/core/considerations'
import {
  MAX_SEEN_PER_MONITOR,
  addMonitor,
  alertsPath,
  appendAlert,
  loadAlerts,
  loadMonitors,
  loadState,
  monitorsPath,
  removeMonitor,
  saveState
} from '../src/core/monitors'
import type { NewsAlert } from '../src/shared/types'

describe('config', () => {
  it('lives under HOME, so tests never touch the real ~/.config/stox', () => {
    expect(configDir()).toBe(path.join(process.env.HOME!, '.config', 'stox'))
  })

  it('parses .env files: comments, quotes, export prefixes, trailing comments', () => {
    const file = path.join(process.env.HOME!, 'test.env')
    fs.writeFileSync(
      file,
      '# comment\nA=1\nexport B="two words"\nC=\'3\'\nD=4 # note\n\nnot a pair\nE=\n'
    )
    expect(parseEnvFile(file)).toEqual({ A: '1', B: 'two words', C: '3', D: '4', E: '' })
    expect(parseEnvFile(path.join(process.env.HOME!, 'missing.env'))).toEqual({})
  })

  it('loads the user file, with the project file winning over it', () => {
    writeUserEnv({ EODHD_API_KEY: 'user', STOX_LLM_PROVIDER: 'openai' })
    const project = path.join(process.env.HOME!, 'project.env')
    fs.writeFileSync(project, 'EODHD_API_KEY=project\n')
    loadEnv(project)
    expect(process.env.EODHD_API_KEY).toBe('project')
    expect(process.env.STOX_LLM_PROVIDER).toBe('openai')
  })

  it('never overrides a real exported variable', () => {
    process.env.EODHD_API_KEY = 'exported'
    writeUserEnv({ EODHD_API_KEY: 'file' })
    loadEnv()
    expect(process.env.EODHD_API_KEY).toBe('exported')
  })

  it('picks up changes and removals on reload', () => {
    writeUserEnv({ EODHD_API_KEY: 'one', DEEPSEEK_API_KEY: 'k' })
    loadEnv()
    fs.writeFileSync(userEnvPath(), 'EODHD_API_KEY=two\n')
    loadEnv()
    expect(process.env.EODHD_API_KEY).toBe('two')
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined()
  })

  it('writeUserEnv merges into the file and drops emptied keys', () => {
    writeUserEnv({ A: '1', B: '2' })
    writeUserEnv({ B: '', C: '3' })
    expect(parseEnvFile(userEnvPath())).toEqual({ A: '1', C: '3' })
  })

  it('missing files are fine', () => {
    expect(() => loadEnv(path.join(process.env.HOME!, 'nope.env'))).not.toThrow()
  })
})

describe('considerations', () => {
  it('round-trips, skipping duplicates and blanks, trimming whitespace', () => {
    expect(loadConsiderations()).toEqual([])
    addConsideration('  insider selling  ')
    addConsideration('insider selling')
    addConsideration('   ')
    addConsideration('tariffs')
    expect(loadConsiderations()).toEqual(['insider selling', 'tariffs'])
  })

  it('skips blank lines and # comments in a hand-edited file', () => {
    fs.mkdirSync(configDir(), { recursive: true })
    fs.writeFileSync(considerationsPath(), '# mine\n\nfirst\n  # indented comment\nsecond\n')
    expect(loadConsiderations()).toEqual(['first', 'second'])
  })

  it('removes one', () => {
    addConsideration('a')
    addConsideration('b')
    expect(removeConsideration(' a ')).toEqual(['b'])
    expect(loadConsiderations()).toEqual(['b'])
  })
})

describe('monitors', () => {
  it('no file means no monitors; a corrupt file reads as empty', () => {
    expect(loadMonitors()).toEqual([])
    fs.mkdirSync(configDir(), { recursive: true })
    fs.writeFileSync(monitorsPath(), '{not json')
    expect(loadMonitors()).toEqual([])
  })

  it('cleans input and persists', () => {
    const m = addMonitor('  oil up ', [' Iran ', '', 'OPEC output'], ['uso', ' ', 'xom '])
    expect(m).toMatchObject({ goal: 'oil up', queries: ['Iran', 'OPEC output'], tickers: ['USO', 'XOM'] })
    expect(m.id).toMatch(/^[0-9a-f]{8}$/)
    expect(loadMonitors()).toEqual([m])
  })

  it('needs a query; the goal falls back to the first one', () => {
    expect(() => addMonitor('goal', [' ', ''], [])).toThrow(/at least one search query/)
    expect(addMonitor('', ['Iran'], []).goal).toBe('Iran')
  })

  it('removes by id', () => {
    const a = addMonitor('a', ['q'], [])
    const b = addMonitor('b', ['q'], [])
    expect(removeMonitor(a.id)).toBe(true)
    expect(removeMonitor(a.id)).toBe(false)
    expect(loadMonitors()).toEqual([b])
  })

  it('caps seen headlines and drops deleted monitors from state', () => {
    const seen = Array.from({ length: MAX_SEEN_PER_MONITOR + 5 }, (_, i) => `k${i}`)
    saveState({ keep: seen, gone: ['x'] }, new Set(['keep']))
    const state = loadState()
    expect(Object.keys(state)).toEqual(['keep'])
    expect(state.keep).toHaveLength(MAX_SEEN_PER_MONITOR)
    expect(state.keep[0]).toBe('k5')
  })

  it('alerts come back newest first, limited, skipping torn lines', () => {
    for (let i = 0; i < 5; i++) appendAlert({ id: `a${i}` } as NewsAlert)
    fs.appendFileSync(alertsPath(), '{torn\n')
    expect(loadAlerts(3).map((a) => a.id)).toEqual(['a4', 'a3', 'a2'])
  })

  it('writes leave no temp file behind', () => {
    addMonitor('a', ['q'], [])
    expect(fs.readdirSync(configDir()).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})
