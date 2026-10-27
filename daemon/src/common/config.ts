/**
 * Locating the workspace and reading its config. A workspace is a folder the
 * developer owns: `projects/<category>/<repo>` git repos (clones or symlinks),
 * optional `flow.config.json`, shared skills and standards. Nothing here is
 * specific to any company or tool layout.
 *
 * Resolution order: FLOW_WORKSPACE, then the --workspace CLI arg, then walk up
 * from cwd looking for flow.config.json or a projects/ dir, then ~/flow-workspace.
 * The current config is held in a module slot so AI Setup can re-resolve it
 * (reloadConfig) and every route sees the change through getConfig().
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { FlowCommand, FlowConfig } from './types.ts'

export const CONFIG_FILE = 'flow.config.json'

const DEFAULTS = {
  projectsDir: 'projects',
  skillsDir: '.agents/skills',
  standardsDir: 'standards',
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Walk up from `start` looking for a flow.config.json or a projects/ dir. */
function findUpwards(start: string): string | null {
  let dir = start
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, CONFIG_FILE)) || isDir(path.join(dir, 'projects'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** The workspace root, or null when none can be found. */
export function resolveWorkspace(cliOverride?: string): string | null {
  const fromEnv = process.env.FLOW_WORKSPACE?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  if (cliOverride) return path.resolve(cliOverride)
  const found = findUpwards(process.cwd())
  if (found) return found
  const home = path.join(homedir(), 'flow-workspace')
  return isDir(home) ? home : null
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback
}

/** Reads flow.config.json. Unknown keys are ignored, bad types fall back to defaults. */
function readWorkspaceFile(workspace: string | null): Record<string, unknown> {
  if (!workspace) return {}
  const file = path.join(workspace, CONFIG_FILE)
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const COMMAND_ID = /^[a-z0-9-]+$/

/**
 * Parses the optional `commands` array. An invalid entry is skipped with one
 * console.warn naming why; the rest still load. A duplicate id keeps the first.
 */
function parseCommands(raw: unknown): FlowCommand[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    console.warn('flow.config.json: "commands" must be an array; ignoring it')
    return []
  }
  const out: FlowCommand[] = []
  const seen = new Set<string>()
  raw.forEach((entry, i) => {
    const skip = (why: string) => console.warn(`flow.config.json: commands[${i}] skipped: ${why}`)
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return skip('not an object')
    const e = entry as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id : ''
    if (!COMMAND_ID.test(id)) return skip('id must match ^[a-z0-9-]+$')
    if (seen.has(id)) return skip(`duplicate id "${id}"`)
    const label = typeof e.label === 'string' ? e.label.trim() : ''
    if (!label) return skip('label must be a non-empty string')
    const run = typeof e.run === 'string' ? e.run.trim() : ''
    if (!run) return skip('run must be a non-empty string')
    const scope = e.scope ?? 'repo'
    if (scope !== 'repo' && scope !== 'workspace')
      return skip('scope must be "repo" or "workspace"')
    if (e.confirm !== undefined && typeof e.confirm !== 'boolean')
      return skip('confirm must be true or false')
    let categories: string[] | null = null
    if (e.categories !== undefined) {
      if (!Array.isArray(e.categories) || e.categories.some((c) => typeof c !== 'string'))
        return skip('categories must be an array of strings')
      if (scope === 'workspace') return skip('categories only apply to scope "repo"')
      categories = e.categories.map((c) => (c as string).trim()).filter(Boolean)
    }
    seen.add(id)
    out.push({ id, label, run, scope, categories, confirm: e.confirm === true })
  })
  return out
}

function resolveBin(envName: string, fallbackName: string): string {
  const fromEnv = process.env[envName]
  if (fromEnv) return fromEnv
  const local = path.join(homedir(), '.local', 'bin', fallbackName)
  return existsSync(local) ? local : fallbackName
}

export function loadConfig(cliOverride?: string): FlowConfig {
  const workspace = resolveWorkspace(cliOverride)
  const raw = readWorkspaceFile(workspace)
  const categories = Array.isArray(raw.categories)
    ? raw.categories.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
    : null
  return {
    workspace,
    name: str(raw.name, workspace ? path.basename(workspace) : 'Flow'),
    projectsDir: str(raw.projectsDir, DEFAULTS.projectsDir),
    categories: categories && categories.length ? categories : null,
    skillsDir: str(raw.skillsDir, DEFAULTS.skillsDir),
    standardsDir: str(raw.standardsDir, DEFAULTS.standardsDir),
    claudeBin: resolveBin('CLAUDE_BIN', 'claude'),
    codexBin: resolveBin('CODEX_BIN', 'codex'),
    commands: parseCommands(raw.commands),
  }
}

let current: FlowConfig | null = null
let cliWorkspace: string | undefined

/** The config for this daemon process. Loaded on first use. */
export function getConfig(): FlowConfig {
  if (!current) current = loadConfig(cliWorkspace)
  return current
}

/** Re-resolves the workspace from disk (after AI Setup writes files). */
export function reloadConfig(): FlowConfig {
  current = loadConfig(cliWorkspace)
  return current
}

/** Called once from main.ts with the --workspace argument, if any. */
export function setCliWorkspace(p: string | undefined): void {
  cliWorkspace = p
  current = null
}

/** An absolute path inside the workspace, or null when there is no workspace. */
export function workspacePath(config: FlowConfig, ...parts: string[]): string | null {
  return config.workspace ? path.join(config.workspace, ...parts) : null
}

export function projectsRoot(config: FlowConfig): string | null {
  return workspacePath(config, config.projectsDir)
}
