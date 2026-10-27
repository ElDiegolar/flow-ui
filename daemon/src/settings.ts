/**
 * The daemon's persisted settings — the ONE place integration config lives.
 *
 * Before this, the Atlassian and Figma endpoints were each read from env vars in
 * two modules (the orchestrator's MCP writer and the Setup check), which is how
 * the orchestrator ended up pointed at a different Atlassian URL than the one
 * the developer had authenticated. Env vars still work, but only as the
 * defaults for a fresh settings.json; after that the Setup tab owns them.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HOME_FILES } from './common/home.ts'
import {
  allProfiles,
  findProfile,
  publicProfile,
  sanitizeProfiles,
  type ModelProfile,
} from './models.ts'

/** A model profile id (models.ts) — 'claude', 'codex', or a custom one. */
export type OrchestratorAgent = string

export type AtlassianSettings = {
  enabled: boolean
  /** Remote MCP endpoint mcp-remote proxies to. The OAuth token is cached per URL. */
  url: string
  /**
   * Connect once when the daemon starts — but only if a token for `url` is
   * already cached, so a restart never opens a login window on its own.
   */
  autoConnect: boolean
}

export type FigmaSettings = {
  enabled: boolean
  /** Figma Desktop's local streamable-HTTP MCP endpoint. */
  url: string
  /**
   * Absolute folder get_design_context writes a frame's images, vectors and
   * videos to — its own folder, not part of any project. Empty = don't write.
   */
  assetsDir: string
}

/**
 * Which optional UI tabs are shown in the strip. Tasks, Orchestrator and Setup
 * are deliberately absent: they are the core flow (start work, run agents, fix
 * configuration), so they are always visible and can never be hidden.
 */
export type TabSettings = {
  dashboard: boolean
  visual: boolean
  agent: boolean
  commit: boolean
  diff: boolean
}

export type Settings = {
  /** When true, the orchestrator may read Jira but never create/edit/transition. */
  jiraReadOnly: boolean
  /** Which model profile backs the orchestrator. Remembered across start/restart. */
  orchestratorAgent: OrchestratorAgent
  /** Profile a sub-agent gets when run_agent names none. */
  subagentDefault: string
  /** Custom model profiles (the built-ins are added by models.ts). */
  models: ModelProfile[]
  atlassian: AtlassianSettings
  figma: FigmaSettings
  /** Re-sync the selected Jira board every N minutes while connected. 0 = manual only. */
  jiraSyncMinutes: number
  /**
   * When the first-run integration intro was finished or skipped. Null shows
   * it on load; Setup → "Re-run setup" clears it again.
   */
  onboardedAt: number | null
  /** Optional tabs to show in the strip. Hiding one never makes it unreachable in-session. */
  tabs: TabSettings
}

const DEFAULTS: Settings = {
  jiraReadOnly: true,
  orchestratorAgent: 'claude',
  subagentDefault: 'codex',
  models: [],
  atlassian: {
    enabled: process.env.FLOW_ATLASSIAN_MCP !== '0',
    // /v1/mcp (streamable HTTP), not the deprecated /v1/sse — and the same URL
    // the developer's own Claude Code config uses, so it shares their token.
    url: process.env.FLOW_ATLASSIAN_MCP_URL ?? 'https://mcp.atlassian.com/v1/mcp',
    autoConnect: true,
  },
  figma: {
    enabled: process.env.FLOW_FIGMA_MCP !== '0',
    url: process.env.FLOW_FIGMA_MCP_URL ?? 'http://127.0.0.1:3845/mcp',
    assetsDir: process.env.FLOW_FIGMA_ASSETS_DIR ?? path.join(os.homedir(), 'figma-assets'),
  },
  jiraSyncMinutes: 5,
  // The e2e suite starts from an empty home; the intro would cover every page.
  onboardedAt: process.env.FLOW_SKIP_INTRO === '1' ? 0 : null,
  tabs: { dashboard: true, visual: true, agent: true, commit: true, diff: true },
}

export function getSettings(): Settings {
  let raw: Partial<Settings> = {}
  try {
    raw = JSON.parse(readFileSync(HOME_FILES.settings, 'utf8')) as Partial<Settings>
  } catch {
    /* fresh install — defaults */
  }
  return {
    ...DEFAULTS,
    ...raw,
    atlassian: { ...DEFAULTS.atlassian, ...raw.atlassian },
    figma: { ...DEFAULTS.figma, ...raw.figma },
    tabs: { ...DEFAULTS.tabs, ...raw.tabs },
    models: Array.isArray(raw.models) ? raw.models : [],
  }
}

const isUrl = (v: unknown): v is string => {
  if (typeof v !== 'string') return false
  try {
    return /^https?:$/.test(new URL(v).protocol)
  } catch {
    return false
  }
}

export type SettingsPatch = Partial<Omit<Settings, 'atlassian' | 'figma' | 'tabs'>> & {
  atlassian?: Partial<AtlassianSettings>
  figma?: Partial<FigmaSettings>
  tabs?: Partial<TabSettings>
}

/** Settings as the web sees them: model keys stripped, built-ins included. */
export function publicSettings(s: Settings = getSettings()) {
  return { ...s, models: allProfiles(s.models).map(publicProfile) }
}

/** Apply a patch, ignoring any field of the wrong type rather than persisting it. */
export function updateSettings(patch: SettingsPatch): Settings {
  const next = getSettings()
  if (typeof patch.jiraReadOnly === 'boolean') next.jiraReadOnly = patch.jiraReadOnly
  // Profiles first, so a patch can add a model and select it in one go. A bad
  // profile throws — the route turns that into a 400 with the reason.
  if (patch.models !== undefined) next.models = sanitizeProfiles(patch.models, next.models)
  if (
    typeof patch.orchestratorAgent === 'string' &&
    findProfile(next.models, patch.orchestratorAgent)
  )
    next.orchestratorAgent = patch.orchestratorAgent
  if (typeof patch.subagentDefault === 'string' && findProfile(next.models, patch.subagentDefault))
    next.subagentDefault = patch.subagentDefault
  // A deleted profile can't stay selected.
  if (!findProfile(next.models, next.orchestratorAgent)) next.orchestratorAgent = 'claude'
  if (!findProfile(next.models, next.subagentDefault)) next.subagentDefault = 'codex'
  if (
    typeof patch.jiraSyncMinutes === 'number' &&
    Number.isFinite(patch.jiraSyncMinutes) &&
    patch.jiraSyncMinutes >= 0
  )
    next.jiraSyncMinutes = Math.round(patch.jiraSyncMinutes)
  if (patch.onboardedAt === null || typeof patch.onboardedAt === 'number')
    next.onboardedAt = patch.onboardedAt
  const t = patch.tabs
  if (t) {
    if (typeof t.dashboard === 'boolean') next.tabs.dashboard = t.dashboard
    if (typeof t.visual === 'boolean') next.tabs.visual = t.visual
    if (typeof t.agent === 'boolean') next.tabs.agent = t.agent
    if (typeof t.commit === 'boolean') next.tabs.commit = t.commit
    if (typeof t.diff === 'boolean') next.tabs.diff = t.diff
  }
  const a = patch.atlassian
  if (a) {
    if (typeof a.enabled === 'boolean') next.atlassian.enabled = a.enabled
    if (typeof a.autoConnect === 'boolean') next.atlassian.autoConnect = a.autoConnect
    if (isUrl(a.url)) next.atlassian.url = a.url
  }
  const f = patch.figma
  if (f) {
    if (typeof f.enabled === 'boolean') next.figma.enabled = f.enabled
    if (isUrl(f.url)) next.figma.url = f.url
    if (typeof f.assetsDir === 'string') {
      const dir = f.assetsDir.trim().replace(/^~(?=\/|$)/, os.homedir())
      if (!dir || path.isAbsolute(dir)) next.figma.assetsDir = dir && path.normalize(dir)
    }
  }
  mkdirSync(path.dirname(HOME_FILES.settings), { recursive: true })
  writeFileSync(HOME_FILES.settings, JSON.stringify(next, null, 2), { mode: 0o600 })
  return next
}
