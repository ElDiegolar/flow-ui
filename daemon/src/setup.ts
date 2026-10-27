/**
 * First-run readiness: what this machine has configured, and what it doesn't.
 *
 * Nothing here authenticates anything — every credential belongs to a CLI that
 * already owns its own login flow, and re-implementing those would mean holding
 * secrets we have no business holding. What the daemon can do is answer "is it
 * set up?" honestly and name the one command that fixes each gap, so a fresh
 * developer sees a checklist instead of an agent that fails silently three
 * steps later.
 *
 * Detection is deliberately by artifact-on-disk rather than by invoking each
 * CLI: it stays fast enough to poll, and it can't hang the request on a tool
 * that decides to prompt.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { codexHome } from './common/agents.ts'
import { HOME_FILES } from './common/home.ts'
import { listProjects } from './common/project.ts'
import { hubStatus } from './integrations/hub.ts'
import { jiraSites, lastJiraAccess } from './integrations/jiraBoard.ts'
import type { FlowConfig } from './common/types.ts'
import { findProfile, type ModelProfile } from './models.ts'
import { getSettings } from './settings.ts'

export type CheckStatus = 'ready' | 'missing' | 'unknown'

export type SetupCheck = {
  id: string
  /** Group heading in the UI: coding agents, the MCP servers they use, or the host. */
  group: 'agent' | 'mcp' | 'host'
  label: string
  status: CheckStatus
  /** Whether the app is unusable without this, or merely degraded. */
  required: boolean
  /** One line on what is (or isn't) there. */
  detail: string
  /** The command the developer runs to fix it, if there is one. */
  fix: string | null
  /** Where we looked, so the answer is checkable rather than magic. */
  evidence: string | null
}

export type SetupReport = {
  checks: SetupCheck[]
  /** True when every required check passes. */
  ready: boolean
  /** True when NOTHING is authenticated — the first-run case worth shouting about. */
  unconfigured: boolean
}

/** Is `bin` an executable file, or resolvable on PATH? */
function binaryPresent(bin: string): boolean {
  if (bin.includes(path.sep)) return existsSync(bin)
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((d) => d && existsSync(path.join(d, bin)))
}

/** Claude Code stores its login under ~/.claude/.credentials.json. */
function claudeAuthenticated(): { ok: boolean; evidence: string | null } {
  const cred = path.join(homedir(), '.claude', '.credentials.json')
  if (existsSync(cred) && statSync(cred).size > 2) return { ok: true, evidence: cred }
  return { ok: false, evidence: null }
}

/** Codex keeps auth.json inside its CODEX_HOME. */
function codexAuthenticated(): { ok: boolean; evidence: string | null } {
  const auth = path.join(codexHome(), 'auth.json')
  if (existsSync(auth) && statSync(auth).size > 2) return { ok: true, evidence: auth }
  return { ok: false, evidence: null }
}

/**
 * Figma Desktop publishes its MCP server on loopback only while the app is
 * running, so reachability is the whole check — there is no stored credential
 * to look for. Short timeout: this runs on every Setup poll and a hung probe
 * would stall the page.
 */
async function figmaReachable(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 700)
    // Any HTTP answer means something is listening; MCP will reject a bare GET
    // with 4xx/405, which still tells us the server is up.
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    return res.status > 0
  } catch {
    return false
  }
}

export async function setupReport(config: FlowConfig): Promise<SetupReport> {
  const checks: SetupCheck[] = []

  // --- coding agents ------------------------------------------------------
  // What the selected models need: a CLI's own LOGIN only matters for a model
  // on that CLI without a custom endpoint (a custom one brings its own key),
  // but the CLI binary is needed by every model that runs through it.
  const settings = getSettings()
  const inUse = [...new Set([settings.orchestratorAgent, settings.subagentDefault])]
    .map((id) => findProfile(settings.models, id))
    .filter((p): p is ModelProfile => Boolean(p))
  const needsLogin = (engine: string) => inUse.some((p) => p.engine === engine && !p.baseUrl)
  const needsBinary = (engine: string) => inUse.some((p) => p.engine === engine)

  const claudeBin = binaryPresent(config.claudeBin)
  const claudeAuth = claudeAuthenticated()
  const claudeLogin = needsLogin('claude')
  checks.push({
    id: 'claude',
    group: 'agent',
    label: 'Claude Code',
    status: !claudeBin ? 'missing' : claudeAuth.ok || !claudeLogin ? 'ready' : 'missing',
    required: needsBinary('claude'),
    detail: !claudeBin
      ? `No claude binary at ${config.claudeBin}.`
      : claudeAuth.ok
        ? 'Installed and logged in.'
        : claudeLogin
          ? 'Installed but not logged in — agents will start and immediately fail.'
          : 'Installed. Not logged in, which is fine: the selected models use their own endpoint.',
    fix: !claudeBin
      ? 'Install Claude Code, or set CLAUDE_BIN to its path.'
      : claudeAuth.ok || !claudeLogin
        ? null
        : 'claude  (then /login)',
    evidence: claudeAuth.evidence ?? (claudeBin ? config.claudeBin : null),
  })

  const codexAuth = codexAuthenticated()
  checks.push({
    id: 'codex',
    group: 'agent',
    label: 'Codex',
    status: codexAuth.ok || !needsLogin('codex') ? 'ready' : 'missing',
    // Required only while a selected model uses codex's own login.
    required: needsLogin('codex'),
    detail: codexAuth.ok
      ? 'Authenticated in CODEX_HOME.'
      : 'No auth.json in CODEX_HOME — codex agents will fail to start.',
    fix: codexAuth.ok ? null : `CODEX_HOME=${codexHome()} codex  (then log in)`,
    evidence: codexAuth.evidence ?? codexHome(),
  })

  // Each selected custom model: is it configured? Reachability is the Models
  // panel's Test button — a network probe on every Setup refresh would be slow.
  for (const p of inUse.filter((m) => !m.builtin && m.baseUrl)) {
    const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(p.baseUrl!)
    const keyOk = Boolean(p.apiKey) || local
    checks.push({
      id: `model:${p.id}`,
      group: 'agent',
      label: `Model: ${p.label}`,
      status: keyOk ? 'ready' : 'missing',
      required: true,
      detail: `${p.engine} CLI → ${p.baseUrl}${p.model ? ` (${p.model})` : ''}, ${
        p.apiKey ? 'key set' : local ? 'local, no key' : 'no API key'
      }. Setup → Models → Test checks it answers.`,
      fix: keyOk ? null : 'Setup → Models → Edit → add the API key',
      evidence: null,
    })
  }

  // --- MCP servers --------------------------------------------------------
  // Read from the hub — the one connection the daemon holds per server — so
  // this reports what agents will actually get, not just what is on disk.
  const hub = hubStatus()
  const at = hub.atlassian
  // Connected is not enough: an Atlassian login is consented per product, and
  // one granted only Confluence connects fine and then 404s every Jira call.
  let access = lastJiraAccess()
  if (at.state === 'connected' && (!access || Date.now() - access.at > 10 * 60_000)) {
    try {
      await jiraSites()
    } catch {
      /* leave the last answer */
    }
    access = lastJiraAccess()
  }
  const noJira = at.state === 'connected' && access !== null && access.sites === 0
  checks.push({
    id: 'atlassian-mcp',
    group: 'mcp',
    label: 'Atlassian (Jira)',
    status:
      at.state === 'disabled'
        ? 'unknown'
        : at.state === 'connected' && !noJira
          ? 'ready'
          : 'missing',
    required: false,
    detail: noJira
      ? `Connected, but this login has no Jira access (${access?.withoutJira.join(', ') || 'no sites'}).`
      : at.state === 'connected'
        ? `Connected to ${at.url} — the board syncs and agents can use Jira.`
        : at.detail,
    fix: noJira
      ? 'Setup → Atlassian → Reset, then Connect — and tick your Jira site on the consent screen.'
      : at.state === 'connected' || at.state === 'disabled'
        ? null
        : at.tokenCached
          ? 'Setup → Atlassian → Connect (a login is cached — no browser window).'
          : 'Setup → Atlassian → Connect (opens one Atlassian sign-in window).',
    evidence: at.tokenFile,
  })

  // --- host: workspace ---------------------------------------------------
  const projects = listProjects(config)
  const repoCount = projects.reduce((n, p) => n + p.repos.length, 0)
  const haveWorkspace = Boolean(config.workspace) && repoCount > 0
  checks.push({
    id: 'workspace',
    group: 'host',
    label: 'Workspace',
    status: haveWorkspace ? 'ready' : 'missing',
    required: true,
    detail: haveWorkspace
      ? `${repoCount} repo${repoCount === 1 ? '' : 's'} in ${projects.length} categor${
          projects.length === 1 ? 'y' : 'ies'
        } under ${config.workspace}.`
      : config.workspace
        ? `Workspace at ${config.workspace} has no repos yet. Use AI Setup below.`
        : 'No workspace found. Use AI Setup below or set FLOW_WORKSPACE.',
    fix: haveWorkspace
      ? null
      : 'Setup → Workspace → AI Setup, or set FLOW_WORKSPACE to a folder of git repos.',
    evidence: config.workspace,
  })

  const fg = hub.figma
  const figmaUp =
    fg.state === 'connected' || (fg.state !== 'disabled' && (await figmaReachable(fg.url)))
  checks.push({
    id: 'figma-mcp',
    group: 'mcp',
    label: 'Figma (Desktop)',
    status: fg.state === 'disabled' ? 'unknown' : figmaUp ? 'ready' : 'missing',
    required: false,
    detail:
      fg.state === 'disabled'
        ? 'Turned off in Setup.'
        : figmaUp
          ? 'Figma Desktop is running and serving its local MCP endpoint.'
          : 'Figma Desktop is not running — the agent cannot read designs a task links to.',
    fix:
      fg.state === 'disabled' || figmaUp
        ? null
        : 'Open Figma Desktop (Preferences → Enable local MCP server), then Re-check.',
    evidence: figmaUp ? fg.url : null,
  })

  const ready = checks.filter((c) => c.required).every((c) => c.status === 'ready')
  const unconfigured = checks
    .filter((c) => c.group === 'agent' || c.group === 'mcp')
    .every((c) => c.status !== 'ready')

  return { checks, ready, unconfigured }
}

/** The MCP config Flow writes for the orchestrator, for display only. */
export function mcpConfigPath(): string {
  return HOME_FILES.mcpConfig
}

/** Server names currently wired into the orchestrator's MCP config, if written. */
export function configuredMcpServers(): string[] {
  try {
    const raw = JSON.parse(readFileSync(mcpConfigPath(), 'utf8')) as {
      mcpServers?: Record<string, unknown>
    }
    return Object.keys(raw.mcpServers ?? {}).sort()
  } catch {
    return []
  }
}
