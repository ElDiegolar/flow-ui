/**
 * Park / resume for tasks.
 *
 * A task's live work = the orchestrator session + its sub-agents (codex/claude).
 * PARK snapshots each session's terminal scrollback to disk and stops the
 * processes; RESUME re-spawns a fresh orchestrator + sub-agents and lets the UI
 * replay the saved scrollback above the new live output. This is what makes a
 * task survivable across "I'll come back to it later" and daemon restarts.
 *
 * Storage mirrors tasks.ts: plain files under FLOW_HOME, no DB.
 *   tasks/<taskId>/manifest.json          — roster + pin
 *   tasks/<taskId>/history/<oldId>.log    — raw ANSI scrollback per session
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { projectsRoot } from './common/config.ts'
import { HOME_DIRS } from './common/home.ts'
import type { FlowConfig } from './common/types.ts'
import {
  orchestratorId,
  orchestratorPin,
  restartOrchestrator,
  stopOrchestrator,
  type OrchestratorPin,
} from './orchestrator/index.ts'
import { getSession, killSession, sessionsByParent } from './pty.ts'
import { findProfile } from './models.ts'
import { spawnCommandSession } from './sessions.ts'
import { getSettings } from './settings.ts'
import { getTask, listTasks, updateTask } from './tasks.ts'

const PARK_DIR = HOME_DIRS.parked

export type ParkedSession = {
  oldId: string
  role: string | null
  kind: string
  label: string
  order: number
  /** Spawn command to re-create a sub-agent on resume (orchestrator omits this). */
  command?: 'agent' | 'agent-codex' | 'agent-claude'
  /** Model profile the sub-agent ran on (older manifests only have `command`). */
  profile?: string
  category?: string | null
  repo?: string | null
}

export type ParkManifest = {
  taskId: string
  parkedAt: number
  pin: OrchestratorPin | null
  sessions: ParkedSession[]
}

function taskDir(taskId: string): string {
  return path.join(PARK_DIR, taskId)
}
function manifestPath(taskId: string): string {
  return path.join(taskDir(taskId), 'manifest.json')
}
function historyPath(taskId: string, oldId: string): string {
  return path.join(taskDir(taskId), 'history', `${oldId}.log`)
}

/** Recover {category, repo} (lowercase slug) from a sub-agent's cwd, or null
 * if it ran at the workspace root. Good enough to re-spawn into the same repo. */
function repoFromCwd(config: FlowConfig, cwd: string): { category: string; repo: string } | null {
  const root = projectsRoot(config)
  if (!root) return null
  const base = root + path.sep
  if (!cwd.startsWith(base)) return null
  const parts = cwd.slice(base.length).split(path.sep).filter(Boolean)
  if (parts.length < 2) return null
  return { category: parts[0], repo: parts[1] }
}

export function isParked(taskId: string): boolean {
  return existsSync(manifestPath(taskId))
}

export function parkedManifest(taskId: string): ParkManifest | null {
  try {
    return JSON.parse(readFileSync(manifestPath(taskId), 'utf8')) as ParkManifest
  } catch {
    return null
  }
}

export function readParkedHistory(taskId: string, oldId: string): string | null {
  try {
    return readFileSync(historyPath(taskId, oldId), 'utf8')
  } catch {
    return null
  }
}

/**
 * Snapshot the active task's live sessions to disk, then stop them. Returns the
 * manifest, or null if there is no running orchestrator to park.
 *
 * `killProcesses=false` is used on shutdown (the process is exiting anyway), so
 * we persist scrollback without racing the SIGINT teardown.
 */
export function parkTask(
  config: FlowConfig,
  taskId: string,
  killProcesses = true,
): ParkManifest | null {
  const orchId = orchestratorId()
  if (!orchId) return null
  const orch = getSession(orchId)
  if (!orch) return null

  const children = sessionsByParent(orchId, true)
  mkdirSync(path.join(taskDir(taskId), 'history'), { recursive: true })

  const sessions: ParkedSession[] = []
  // Orchestrator first (order 0) — resume re-creates it via startOrchestrator.
  writeFileSync(historyPath(taskId, orch.id), orch.output, { mode: 0o600 })
  sessions.push({
    oldId: orch.id,
    role: 'orchestrator',
    kind: orch.kind,
    label: orch.invocation.label,
    order: 0,
  })

  children
    .sort((a, b) => a.startedAt - b.startedAt)
    .forEach((c, i) => {
      writeFileSync(historyPath(taskId, c.id), c.output, { mode: 0o600 })
      const loc = repoFromCwd(config, c.invocation.cwd ?? config.workspace ?? '')
      sessions.push({
        oldId: c.id,
        role: c.role,
        kind: c.kind,
        label: c.invocation.label,
        order: i + 1,
        command: 'agent',
        profile: c.role ?? 'codex',
        category: loc?.category ?? null,
        repo: loc?.repo ?? null,
      })
    })

  const task = getTask(taskId)
  // Record what the orchestrator is ACTUALLY pinned to, not what the task
  // record says. The two drift — a task pinned to web/app whose
  // orchestrator was started on another repo would otherwise resume into the wrong
  // repo. The task's own fields are only the fallback.
  const manifest: ParkManifest = {
    taskId,
    parkedAt: Date.now(),
    pin:
      orchestratorPin() ??
      (task?.category && task?.repo ? { category: task.category, repo: task.repo } : null),
    sessions,
  }
  writeFileSync(manifestPath(taskId), JSON.stringify(manifest, null, 2), { mode: 0o600 })

  if (killProcesses) {
    for (const c of children) killSession(c.id)
    stopOrchestrator()
  }
  return manifest
}

/**
 * The first turn handed to each agent on resume.
 *
 * Resume re-spawns processes, and a fresh process remembers nothing — the saved
 * `.log` files are replayed into the xterm for the HUMAN, not the agent. Without
 * a seed the orchestrator came back knowing only its pin, and sub-agents came
 * back with a completely empty prompt. Both then behaved as if the task had
 * never been started.
 *
 * So the seeds do two jobs: restate the task, and tell the agent it is amnesiac
 * — the repo may already hold partial work, and redoing it is the failure mode
 * to avoid. (Phase 2 replaces this with a real `--resume` of the prior
 * conversation; these seeds stay as the fallback for codex and for manifests
 * parked before session ids were recorded.)
 */
function resumeSeeds(
  taskId: string,
  manifest: ParkManifest,
): { orchestrator: string; subagent: string } {
  const task = getTask(taskId)
  const what = task
    ? `${task.jiraKey ? `[${task.jiraKey}] ` : ''}${task.title}` +
      (task.description ? ` — ${task.description}` : '')
    : 'the previously parked task'
  const where = manifest.pin ? ` Project: ${manifest.pin.category}/${manifest.pin.repo}.` : ''
  const parkedAgo = `It was parked on ${new Date(manifest.parkedAt).toISOString()}.`

  return {
    orchestrator:
      `Resuming a parked task: ${what}.${where} ${parkedAgo} You are a FRESH session and do ` +
      `not remember the earlier attempt, so assume nothing was finished and nothing was left ` +
      `undone. Partial work may already be in the working tree, and any sub-agents listed by ` +
      `list_sessions have just been restarted alongside you. Re-establish context first, then ` +
      `tell me what actually remains and delegate it with run_agent — do not re-do work that ` +
      `is already present.`,
    subagent:
      `Resuming a parked task: ${what}. You are a fresh session with no memory of the earlier ` +
      `attempt on this repo, and the working tree may already contain partial work from it. ` +
      `Before changing anything, run \`git status\` and \`git diff\` to see what has already ` +
      `been done. Then wait for the orchestrator's instructions rather than guessing at the ` +
      `next step.`,
  }
}

/**
 * Park whichever task currently owns the live orchestrator, unless that task is
 * `exceptTaskId`. Returns the id of the task it parked, or null if nothing
 * needed parking.
 *
 * There is exactly ONE orchestrator, so every path that takes it over — starting
 * a task, resuming a task — evicts whatever was running. An un-parked eviction
 * loses that task's scrollback since the last snapshot and orphans its
 * sub-agents, so all such paths must call this first.
 */
export function parkActiveTask(config: FlowConfig, exceptTaskId?: string): string | null {
  const oid = orchestratorId()
  if (!oid) return null
  const live = getSession(oid)
  if (!live || live.exited) return null
  const owner = listTasks().find((t) => t.id !== exceptTaskId && t.sessionIds.includes(oid))
  if (!owner) return null
  try {
    if (!parkTask(config, owner.id)) return null
  } catch {
    // Never block the incoming task on a failed park of the outgoing one.
    return null
  }
  updateTask(owner.id, { status: 'parked' })
  return owner.id
}

export type ResumeResult = {
  manifest: ParkManifest
  /** old session id -> new session id, for replaying the right history log. */
  idMap: Record<string, string>
  /** New session ids in manifest order (orchestrator first). */
  newSessionIds: string[]
}

/**
 * Re-spawn a parked task's orchestrator + sub-agents (fresh processes — they
 * lose in-memory state; the UI restores the visible scrollback). Returns the
 * old→new id map so the caller can remap task.sessionIds and the history route
 * can resolve a new id back to its saved log.
 */
export function resumeTask(
  config: FlowConfig,
  taskId: string,
  daemonUrl: string,
  token: string,
): ResumeResult | null {
  const manifest = parkedManifest(taskId)
  if (!manifest) return null

  // Resuming takes over the single orchestrator too, so park the outgoing task
  // before evicting it — same rule as starting one.
  parkActiveTask(config, taskId)

  const idMap: Record<string, string> = {}
  const newSessionIds: string[] = []
  const { orchestrator: orchestratorSeed, subagent: subagentSeed } = resumeSeeds(taskId, manifest)

  const ordered = [...manifest.sessions].sort((a, b) => a.order - b.order)
  for (const entry of ordered) {
    if (entry.order === 0 || entry.role === 'orchestrator') {
      // restartOrchestrator nulls currentOrchestratorId first, so it always
      // starts a fresh process instead of returning a still-draining one.
      restartOrchestrator(config, daemonUrl, token, manifest.pin ?? undefined, orchestratorSeed)
      const newId = orchestratorId()
      if (newId) {
        idMap[entry.oldId] = newId
        newSessionIds.push(newId)
      }
    } else {
      const { id } = spawnCommandSession(config, {
        command: entry.command ?? 'agent-codex',
        // A profile deleted since parking falls back to Setup's sub-agent default.
        profile:
          entry.profile && findProfile(getSettings().models, entry.profile)
            ? entry.profile
            : undefined,
        category: entry.category ?? undefined,
        repo: entry.repo ?? undefined,
        prompt: subagentSeed,
      })
      idMap[entry.oldId] = id
      newSessionIds.push(id)
    }
  }
  return { manifest, idMap, newSessionIds }
}
