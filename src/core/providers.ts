import OpenAI from 'openai'
import { writeUserEnv } from './config'
import type { ChatModel } from './llmTypes'
import { OpenAIChatModel } from './openai'

/**
 * The provider registry: STOX_LLM_PROVIDER / STOX_LLM_MODEL -> a ChatModel,
 * plus the thinking switch.
 *
 * Adding a provider means one entry in LLM_PROVIDERS plus, only if it
 * doesn't speak the OpenAI chat API, an adapter -- the agents never change,
 * since they only see ChatModel.
 */

interface ProviderConfig {
  defaultModel: string
  apiKeyEnv: string
  /** Whether thinking can be switched on and off per request (see STOX_LLM_THINKING). */
  thinkingToggle?: boolean
  /** `thinking` is STOX_LLM_THINKING for providers with thinkingToggle, else undefined. */
  build(model: string, apiKey: string, thinking: boolean | undefined): ChatModel
}

export const LLM_PROVIDERS: Record<string, ProviderConfig> = {
  deepseek: {
    defaultModel: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    thinkingToggle: true,
    build: (model, apiKey, thinking) =>
      new OpenAIChatModel('deepseek', model, new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com' }), thinking)
  },
  openai: {
    defaultModel: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    build: (model, apiKey) => new OpenAIChatModel('openai', model, new OpenAI({ apiKey }))
  }
}

/** Raised when the configured provider can't be used. */
export class AgentError extends Error {}

export function currentProviderName(): string {
  return (process.env.STOX_LLM_PROVIDER || 'deepseek').toLowerCase()
}

/** '<provider>/<model>' for whatever's configured -- safe to show even if
 * the provider is unknown or its key is missing. */
export function describeCurrent(): string {
  const provider = currentProviderName()
  const cfg = LLM_PROVIDERS[provider]
  if (!cfg) return provider
  return `${provider}/${process.env.STOX_LLM_MODEL || cfg.defaultModel}`
}

export function providerKeyPresent(): boolean {
  const cfg = LLM_PROVIDERS[currentProviderName()]
  return Boolean(cfg && process.env[cfg.apiKeyEnv])
}

export function thinkingSupported(): boolean {
  return Boolean(LLM_PROVIDERS[currentProviderName()]?.thinkingToggle)
}

/** STOX_LLM_THINKING: on, or off (the default -- faster and cheaper). */
export function thinkingSetting(): boolean {
  return ['on', 'true', '1', 'yes'].includes((process.env.STOX_LLM_THINKING ?? '').trim().toLowerCase())
}

/** Switches thinking for every later request, and saves the choice to
 * ~/.config/stox/.env so the CLI and the app share it. */
export function setThinking(enabled: boolean): void {
  const value = enabled ? 'on' : 'off'
  process.env.STOX_LLM_THINKING = value
  writeUserEnv({ STOX_LLM_THINKING: value })
}

/** A ChatModel for the configured provider; throws AgentError if it can't be used.
 * `thinking` overrides STOX_LLM_THINKING, e.g. off for a quick side task. */
export function buildLLM(options: { thinking?: boolean } = {}): ChatModel {
  const provider = currentProviderName()
  const cfg = LLM_PROVIDERS[provider]
  if (!cfg) {
    throw new AgentError(
      `unknown STOX_LLM_PROVIDER '${provider}' -- choose from: ${Object.keys(LLM_PROVIDERS).join(', ')}`
    )
  }
  const apiKey = process.env[cfg.apiKeyEnv]
  if (!apiKey) throw new AgentError(`no ${cfg.apiKeyEnv} set for provider '${provider}' -- see /help`)
  return cfg.build(
    process.env.STOX_LLM_MODEL || cfg.defaultModel,
    apiKey,
    cfg.thinkingToggle ? (options.thinking ?? thinkingSetting()) : undefined
  )
}
