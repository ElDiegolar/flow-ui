/**
 * Model profiles — what backs an agent. Every agent still runs through one of
 * the two CLIs Flow knows how to drive (the `engine`), because they own
 * the terminal UI, tool use and permissions. A profile only changes which model
 * that CLI talks to, and where:
 *
 *  - claude engine + baseUrl: any Anthropic-compatible endpoint (OpenRouter,
 *    LiteLLM, Ollama, llama.cpp's /v1/messages) via ANTHROPIC_BASE_URL.
 *  - codex engine + baseUrl: any OpenAI-compatible endpoint via a codex
 *    `model_providers.*` override.
 *  - no baseUrl: the CLI's own login, optionally with a different `--model`.
 *
 * The two built-ins are the old fixed claude/codex choices, so settings and
 * parked tasks that name them keep working. Custom profiles live in
 * settings.json; their API keys never leave the daemon (publicProfile strips
 * them).
 */
import type { Engine } from './common/types.ts'

export type WireApi = 'responses' | 'chat'

export type ModelProfile = {
  /** Slug: what run_agent, settings and sessions refer to it by. */
  id: string
  label: string
  engine: Engine
  /** Passed as the CLI's model (`--model` / `-m`). Omitted → the CLI's default. */
  model?: string
  /** Custom endpoint. Omitted → the engine's own login. */
  baseUrl?: string
  apiKey?: string
  /** codex + baseUrl only: which OpenAI API shape the endpoint speaks. */
  wireApi?: WireApi
  builtin?: boolean
}

/** What the web sees: the key replaced by whether one is set. */
export type PublicProfile = Omit<ModelProfile, 'apiKey'> & { hasKey: boolean }

export const BUILTIN_PROFILES: ModelProfile[] = [
  { id: 'claude', label: 'Claude', engine: 'claude', model: 'opus', builtin: true },
  { id: 'codex', label: 'Codex', engine: 'codex', builtin: true },
]

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/

export function publicProfile(p: ModelProfile): PublicProfile {
  const { apiKey, ...rest } = p
  return { ...rest, hasKey: Boolean(apiKey) }
}

const isUrl = (v: unknown): v is string => {
  if (typeof v !== 'string') return false
  try {
    return /^https?:$/.test(new URL(v).protocol)
  } catch {
    return false
  }
}
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/**
 * Validate the custom profiles sent from the Setup tab. `previous` supplies the
 * stored key for a profile whose key field was left untouched (undefined): the
 * web never has the key, so it can only set a new one or clear it ('').
 */
export function sanitizeProfiles(input: unknown, previous: ModelProfile[]): ModelProfile[] {
  if (!Array.isArray(input)) throw new Error('models must be an array')
  const seen = new Set(BUILTIN_PROFILES.map((b) => b.id))
  return input.map((raw: Partial<ModelProfile>) => {
    const id = text(raw?.id)?.toLowerCase()
    if (!id || !ID_RE.test(id))
      throw new Error(`model id "${raw?.id ?? ''}" must be lowercase letters, digits, - or _`)
    if (seen.has(id)) throw new Error(`model id "${id}" is taken`)
    seen.add(id)
    if (raw.engine !== 'claude' && raw.engine !== 'codex')
      throw new Error(`model "${id}": engine must be claude or codex`)
    if (raw.baseUrl && !isUrl(raw.baseUrl))
      throw new Error(`model "${id}": base URL must be http(s)`)
    const apiKey =
      raw.apiKey === undefined ? previous.find((p) => p.id === id)?.apiKey : text(raw.apiKey)
    return {
      id,
      label: text(raw.label) ?? id,
      engine: raw.engine,
      model: text(raw.model),
      baseUrl: text(raw.baseUrl),
      apiKey,
      wireApi:
        raw.wireApi === 'chat' ? 'chat' : raw.wireApi === 'responses' ? 'responses' : undefined,
    }
  })
}

export function allProfiles(custom: ModelProfile[]): ModelProfile[] {
  return [...BUILTIN_PROFILES, ...custom]
}

export function findProfile(custom: ModelProfile[], id: string): ModelProfile | undefined {
  return allProfiles(custom).find((p) => p.id === id)
}

/** Env var codex reads the custom endpoint's key from (`env_key`). */
const CODEX_KEY_ENV = 'FLOW_MODEL_API_KEY'

/**
 * CLI args + env that point an agent at the profile's model. Shared by the
 * orchestrator and sub-agents so both launch a profile identically.
 */
export function profileLaunch(p: ModelProfile): { args: string[]; env: Record<string, string> } {
  if (p.engine === 'claude') {
    const args = p.model ? ['--model', p.model] : []
    if (!p.baseUrl) return { args, env: {} }
    // Claude Code also makes background calls on its "small/fast" and alias
    // models; point every one of them at the profile's model, or they would hit
    // an Anthropic model name the custom endpoint does not serve.
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: p.baseUrl,
      // Local servers usually take no key, but claude still needs one set to
      // skip its own login.
      ANTHROPIC_AUTH_TOKEN: p.apiKey ?? 'no-key',
      // Blank any inherited Anthropic key: claude would send it alongside, i.e.
      // hand the developer's Anthropic key to a third-party endpoint.
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    }
    if (p.model) {
      for (const k of [
        'ANTHROPIC_MODEL',
        'ANTHROPIC_SMALL_FAST_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      ])
        env[k] = p.model
    }
    return { args, env }
  }

  // codex
  const args = p.model ? ['-m', p.model] : []
  if (!p.baseUrl) return { args, env: {} }
  // Values are TOML: strings are JSON-quoted (see orchestrator/invocation.ts).
  const provider = `flow_${p.id.replace(/-/g, '_')}`
  const set = (k: string, v: string) => [
    '-c',
    `model_providers.${provider}.${k}=${JSON.stringify(v)}`,
  ]
  args.push(
    '-c',
    `model_provider=${JSON.stringify(provider)}`,
    ...set('name', p.label),
    ...set('base_url', p.baseUrl),
    ...set('wire_api', p.wireApi ?? 'responses'),
    ...(p.apiKey ? set('env_key', CODEX_KEY_ENV) : []),
  )
  return { args, env: p.apiKey ? { [CODEX_KEY_ENV]: p.apiKey } : {} }
}

/**
 * Setup's "Test" button: can the daemon reach the endpoint, and does it list
 * the profile's model? Uses the OpenAI/Anthropic-style `GET …/models`, which
 * OpenRouter, LiteLLM, Ollama and llama.cpp all serve.
 */
export async function testProfile(
  p: ModelProfile,
): Promise<{ ok: boolean; detail: string; models?: string[] }> {
  if (!p.baseUrl)
    return { ok: true, detail: `Uses the ${p.engine} CLI's own login — nothing to test here.` }
  const base = p.baseUrl.replace(/\/+$/, '')
  const urls = /\/v1$/.test(base) ? [`${base}/models`] : [`${base}/v1/models`, `${base}/models`]
  const headers: Record<string, string> = {}
  if (p.apiKey) {
    headers.authorization = `Bearer ${p.apiKey}`
    headers['x-api-key'] = p.apiKey
  }
  let last = ''
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
      if (!res.ok) {
        last = `${url} → HTTP ${res.status}`
        continue
      }
      const body = (await res.json()) as { data?: { id?: string }[]; models?: { name?: string }[] }
      const ids = [
        ...(body.data ?? []).map((m) => m.id),
        ...(body.models ?? []).map((m) => m.name),
      ].filter((x): x is string => Boolean(x))
      if (p.model && ids.length && !ids.includes(p.model))
        return {
          ok: false,
          detail: `Reachable, but "${p.model}" is not in its model list.`,
          models: ids.slice(0, 50),
        }
      return {
        ok: true,
        detail: `Reachable — ${ids.length} model(s) listed.`,
        models: ids.slice(0, 50),
      }
    } catch (e) {
      last = `${url} → ${(e as Error).message}`
    }
  }
  return { ok: false, detail: `Could not reach the endpoint (${last}).` }
}
