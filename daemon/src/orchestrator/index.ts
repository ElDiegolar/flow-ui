/**
 * The single, long-lived orchestrator Claude session.
 *
 * It is an ordinary PTY session (so streaming/replay/kill all work via the
 * existing /api/sessions/:id/stream + /replay routes), except its executable is
 * the claude or codex CLI and it is wired to the flow MCP server. We track exactly one at a
 * time so the web "Orchestrator" tab can re-attach across reloads.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexHome } from '../common/agents.ts'
import { resolveRepoPath } from '../common/project.ts'
import { HOME_FILES } from '../common/home.ts'
import type { FlowConfig } from '../common/types.ts'
import { buildOrchestratorBrief, pinSection, type BriefPin } from './brief.ts'
import { buildOrchestratorInvocation, type McpServer, type OrchestratorMcp } from './invocation.ts'
import { getSession, killSession, sessionsByParent, startSession, writeToSession } from '../pty.ts'
import { findProfile } from '../models.ts'
import { projectContext } from '../projectContext.ts'
import { getSettings, updateSettings, type OrchestratorAgent } from '../settings.ts'
import { standardsFor } from '../standards.ts'
import { PASTE_DIR } from '../paste.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const MCP_CONFIG_PATH = HOME_FILES.mcpConfig
// NB: this file is src/orchestrator/index.ts, so __dirname is one level below
// src/ — every path built from it needs the extra '..'.
const MCP_SERVER_SCRIPT = path.join(__dirname, '..', 'mcp', 'flowMcp.ts')

let currentOrchestratorId: string | null = null

/** The id of the running orchestrator session, or null. Used by main.ts to
 * stamp parentId on subagents — valid only while the orchestrator is the sole
 * holder of the flow MCP (the only thing that can call run_agent). */
export function orchestratorId(): string | null {
  return currentOrchestratorId
}

/** Pins the orchestrator to a project/repo so it has the right working context. */
export type OrchestratorPin = { category: string; repo: string }

// The project the running orchestrator is pinned to (drives the Diff and Commit
// tabs' context). Kept across the session; cleared on a fresh unpinned start.
let currentPin: OrchestratorPin | null = null
export function orchestratorPin(): OrchestratorPin | null {
  return currentPin
}

/** Resolve the `tsx` binary used to run the (TypeScript) MCP server. */
function resolveTsx(): string {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'node_modules', '.bin', 'tsx'), // daemon-local
    path.resolve(__dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx'), // hoisted to repo root
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return 'tsx' // fall back to PATH
}

/** The flow MCP server descriptor — the ONLY server either orchestrator
 * engine is given. Jira and Figma go through its jira_call / figma_call tools
 * (the daemon's single connection each — integrations/hub.ts), so restarting
 * the orchestrator never starts an mcp-remote and never opens a login window.
 * Shared by the claude JSON config and the codex `-c` path. */
function flowMcpServer(daemonUrl: string, token: string): McpServer {
  const { atlassian, figma } = getSettings()
  return {
    command: resolveTsx(),
    args: [MCP_SERVER_SCRIPT],
    env: {
      FLOW_URL: daemonUrl,
      FLOW_TOKEN: token,
      // An integration switched off in Setup drops its tools (flowMcp.ts).
      FLOW_MCP_JIRA: atlassian.enabled ? '1' : '0',
      FLOW_MCP_FIGMA: figma.enabled ? '1' : '0',
    },
  }
}

/** The pinned project as the brief states it: path and governing standards. */
function briefPin(config: FlowConfig, pin?: OrchestratorPin): BriefPin | undefined {
  if (!pin) return undefined
  return {
    ...pin,
    repoPath: resolveRepoPath(config, pin.category, pin.repo),
    standards: standardsFor(config, pin.category).map((g) => g.body.trim()),
  }
}

/**
 * Write the orchestrator's `--mcp-config`. The token + daemon URL travel in the
 * server's own env (Claude Code injects it when it spawns the server).
 */
export function writeMcpConfig(daemonUrl: string, token: string): string {
  const mcpServers = { flow: flowMcpServer(daemonUrl, token) }
  mkdirSync(path.dirname(MCP_CONFIG_PATH), { recursive: true })
  writeFileSync(MCP_CONFIG_PATH, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 })
  return MCP_CONFIG_PATH
}

/** Build the MCP wiring both orchestrator agents draw from: the claude JSON
 * config path plus the raw flow server descriptor codex turns into `-c`
 * overrides. */
function buildOrchestratorMcp(daemonUrl: string, token: string): OrchestratorMcp {
  return {
    configPath: writeMcpConfig(daemonUrl, token),
    flow: flowMcpServer(daemonUrl, token),
  }
}

export type OrchestratorStatus = {
  running: boolean
  id: string | null
  label: string | null
  exited: boolean
  exitCode: number | null
  /** The pinned project context, if any. */
  category: string | null
  repo: string | null
  /** Which agent is running (or would be used on next start). */
  agent: OrchestratorAgent
}

export function orchestratorStatus(): OrchestratorStatus {
  const s = currentOrchestratorId ? getSession(currentOrchestratorId) : undefined
  const category = currentPin?.category ?? null
  const repo = currentPin?.repo ?? null
  const agent = getSettings().orchestratorAgent
  if (!s) {
    return {
      running: false,
      id: null,
      label: null,
      exited: false,
      exitCode: null,
      category,
      repo,
      agent,
    }
  }
  return {
    running: !s.exited,
    id: s.id,
    label: s.invocation.label,
    exited: s.exited,
    exitCode: s.exitCode,
    category,
    repo,
    agent,
  }
}

/**
 * Robustly hand the orchestrator its first turn. Claude Code's TUI can take a
 * few seconds to start reading stdin, and bytes written before then are simply
 * dropped — which left the orchestrator parked on an empty prompt ("hanging").
 *
 * So we don't fire-and-forget a single timed write: we send, then verify the
 * agent actually reacted (its output grew well past the static welcome screen).
 * If it didn't, the input was dropped during boot — resend. If it grew but the
 * agent isn't processing, the text may be sitting unsubmitted — nudge Enter.
 */
function seedOrchestrator(id: string, text: string) {
  const len0 = getSession(id)?.output.length ?? 0
  const reacted = () => {
    const s = getSession(id)
    return !!s && s.output.length > len0 + 80
  }
  const attempt = (n: number) => {
    const s = getSession(id)
    if (!s || s.exited) return
    if (n === 0 || !reacted()) {
      promptOrchestrator(text) // (re)send the full brief + Enter
    } else {
      writeToSession(id, '', { enter: true }) // grew but stalled — submit it
    }
    if (n < 2) setTimeout(() => attempt(n + 1), n === 0 ? 2500 : 3000)
  }
  // First attempt once the REPL has had a moment to come up.
  setTimeout(() => attempt(0), 2000)
}

export function startOrchestrator(
  config: FlowConfig,
  daemonUrl: string,
  token: string,
  pin?: OrchestratorPin,
  seed?: string,
  agentArg?: OrchestratorAgent,
): OrchestratorStatus {
  const existing = currentOrchestratorId ? getSession(currentOrchestratorId) : undefined
  if (existing && !existing.exited) return orchestratorStatus()

  // Resolve the agent: an explicit choice wins and is remembered; otherwise reuse
  // the last-used agent from settings.
  const agent: OrchestratorAgent = agentArg ?? getSettings().orchestratorAgent
  const profile = findProfile(getSettings().models, agent)
  if (!profile) throw new Error(`unknown model "${agent}" — add it in Setup → Models`)
  if (agentArg) updateSettings({ orchestratorAgent: agentArg })

  if (!config.workspace)
    throw new Error('no workspace configured: run AI Setup or set FLOW_WORKSPACE')
  const workspace = config.workspace
  const mcp = buildOrchestratorMcp(daemonUrl, token)
  // Ensure the paste dir exists so --add-dir resolves: the agent reads images
  // pasted into the terminal from there.
  mkdirSync(PASTE_DIR, { recursive: true })
  const bPin = briefPin(config, pin)
  // Custom models get the workspace's context files loaded for them; the
  // built-ins keep relying on their CLI's own CLAUDE.md / AGENTS.md discovery.
  const context = profile.builtin
    ? ''
    : projectContext(config, profile.engine, workspace, bPin?.repoPath)
  const invocation = buildOrchestratorInvocation(
    config,
    profile,
    mcp,
    daemonUrl,
    token,
    [PASTE_DIR],
    pin,
    profile.engine === 'codex' ? codexHome() : undefined,
    bPin,
    context,
  )
  const session = startSession({
    cwd: invocation.cwd ?? workspace,
    invocation,
    kind: 'orchestrator',
  })
  currentOrchestratorId = session.id
  currentPin = pin ?? null

  // Only a caller-supplied `seed` (e.g. a task brief) is typed in as a turn. The
  // pin — path, standards, matching skills — is part of the brief (see
  // briefPin), so a plain start costs no inference at all; it used to seed an
  // "acknowledge the pin" turn that made the model answer just to say OK.
  // Codex has no system-prompt flag, so for it the brief rides in as turn one.
  let firstTurn = seed ?? null
  if (profile.engine === 'codex') {
    firstTurn = [
      buildOrchestratorBrief(config, bPin, context),
      '',
      firstTurn ?? 'Reply "ready" and wait for my instructions.',
    ].join('\n')
  }
  if (firstTurn) seedOrchestrator(currentOrchestratorId, firstTurn)
  return orchestratorStatus()
}

/**
 * Move the pin WITHOUT restarting: the live orchestrator keeps its
 * conversation (e.g. the ticket brief Start work gave it) and is told about the
 * new project in one message. A restart would re-pin too, but wipes all that.
 * The Diff and Commit tabs follow via the active context. `--add-dir` can't change
 * on a live claude, which is fine: the orchestrator delegates, and sub-agents
 * start in their own repo.
 */
export function repinOrchestrator(config: FlowConfig, pin: OrchestratorPin): OrchestratorStatus {
  const moved = currentPin?.category !== pin.category || currentPin?.repo !== pin.repo
  currentPin = pin
  const s = currentOrchestratorId ? getSession(currentOrchestratorId) : undefined
  if (moved && s && !s.exited) {
    const bPin = briefPin(config, pin)!
    promptOrchestrator(
      [
        'The pinned project has changed. From now on:',
        '',
        ...pinSection(config, bPin),
        '',
        'Carry on with the current task in this project — no need to reply to this message.',
      ].join('\n'),
    )
  }
  return orchestratorStatus()
}

/**
 * Type a line into the running orchestrator's terminal (as if the user typed
 * it). Returns false if not running.
 */
export function promptOrchestrator(text: string): boolean {
  if (!currentOrchestratorId) return false
  // Delegates to the canonical input path (writeToSession), which writes the
  // text then a SEPARATE Enter after a short pause — Claude's TUI treats a
  // trailing CR in the same chunk as a newline within the input rather than a
  // submit, so a standalone CR is what actually submits the seeded prompt.
  return writeToSession(currentOrchestratorId, text)
}

/**
 * Stop the orchestrator AND the sub-agents it spawned.
 *
 * The sub-agents must go too. They run auto-approved (bypassPermissions /
 * --ask-for-approval never), so one left running after its orchestrator dies
 * keeps editing the repo with nothing watching it and nobody to answer the
 * questions it asks. Killing only the orchestrator — which is what this used
 * to do — leaked an unsupervised writer on every task switch.
 */
export function stopOrchestrator(): OrchestratorStatus {
  if (currentOrchestratorId) {
    for (const child of sessionsByParent(currentOrchestratorId)) killSession(child.id)
    killSession(currentOrchestratorId)
  }
  return orchestratorStatus()
}

export function restartOrchestrator(
  config: FlowConfig,
  daemonUrl: string,
  token: string,
  pin?: OrchestratorPin,
  seed?: string,
  agentArg?: OrchestratorAgent,
): OrchestratorStatus {
  // SIGINT the old session and DETACH it (null the id) before starting, so the
  // new orchestrator gets a fresh id and we never write into the dying process.
  stopOrchestrator()
  currentOrchestratorId = null
  return startOrchestrator(config, daemonUrl, token, pin, seed, agentArg)
}
