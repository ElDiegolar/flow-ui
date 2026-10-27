/**
 * Command-session spawning, factored out of the `/api/sessions` route so the
 * resume flow (park.ts) can re-spawn a task's agents with identical semantics
 * (kind / parentId / role inference) without an HTTP round-trip.
 */
import { buildAgentInvocation, buildGitCommitInvocation } from './functions/index.ts'
import { buildCommandInvocation, CommandError, findCommand } from './commands.ts'
import { resolveRepoPath } from './common/project.ts'
import type { FlowConfig, Invocation } from './common/types.ts'
import { findProfile } from './models.ts'
import { orchestratorId } from './orchestrator/index.ts'
import { getSettings } from './settings.ts'
import { pruneExited, reapIdleSubagents, startSession } from './pty.ts'

export type CommandKind =
  | 'agent'
  | 'agent-codex'
  | 'agent-claude'
  | 'git-commit'
  | 'ai-setup'
  | 'run'

export type SpawnBody = {
  command: CommandKind
  category?: string
  repo?: string
  prompt?: string
  /** `agent` command: model profile id. Omitted → Setup's sub-agent default. */
  profile?: string
  /** `git-commit`: the commit message from the Commit tab. */
  message?: string
  /** `run`: the id of a command from flow.config.json `commands`. */
  id?: string
  /** `run`: must be true to start a command marked `confirm` (the human agreed). */
  confirmed?: boolean
}

/** Thrown for a bad request; the route maps `.status` onto the HTTP reply. */
export class SessionRequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'SessionRequestError'
  }
}

/** Validate the body, build the invocation, and start the PTY session. */
export function spawnCommandSession(
  config: FlowConfig,
  body: SpawnBody,
): { id: string; label: string } {
  const { command, category, repo, prompt, message, id, confirmed } = body
  if (command === 'ai-setup') {
    throw new SessionRequestError(400, 'start AI setup via POST /api/setup/ai')
  }
  if (!config.workspace) {
    throw new SessionRequestError(409, 'no workspace yet: run AI Setup or set FLOW_WORKSPACE')
  }
  // agent-codex / agent-claude are the built-in profiles under their old names.
  const isSubagent = command === 'agent' || command === 'agent-codex' || command === 'agent-claude'
  const settings = getSettings()
  const profileId =
    command === 'agent-codex'
      ? 'codex'
      : command === 'agent-claude'
        ? 'claude'
        : (body.profile ?? settings.subagentDefault)
  const profile = isSubagent ? findProfile(settings.models, profileId) : undefined
  if (isSubagent && !profile)
    throw new SessionRequestError(400, `unknown model "${profileId}" — add it in Setup → Models`)
  let invocation: Invocation
  switch (command) {
    case 'agent':
    case 'agent-codex':
    case 'agent-claude':
      invocation = buildAgentInvocation(profile!, config, category, repo, prompt)
      break
    case 'git-commit': {
      if (!category || !repo) throw new SessionRequestError(400, 'category and repo required')
      if (!message?.trim()) throw new SessionRequestError(400, 'commit message required')
      const dir = resolveRepoPath(config, category, repo)
      if (!dir) throw new SessionRequestError(400, 'repo not found')
      invocation = buildGitCommitInvocation(dir, `${repo} (${category})`, message.trim())
      break
    }
    case 'run': {
      if (!id) throw new SessionRequestError(400, 'id required')
      const cmd = findCommand(config, id)
      if (!cmd) throw new SessionRequestError(400, `unknown command: ${id}`)
      if (cmd.confirm && confirmed !== true)
        throw new SessionRequestError(
          400,
          `"${cmd.label}" is destructive: ask the human first, then send confirmed: true`,
        )
      try {
        invocation = buildCommandInvocation(config, id, category, repo)
      } catch (err) {
        if (err instanceof CommandError) throw new SessionRequestError(err.status, err.message)
        throw err
      }
      break
    }
    default:
      throw new SessionRequestError(400, `unknown command: ${command}`)
  }
  pruneExited()
  // Subagents are spawned only via run_agent, which only the orchestrator can
  // call, so any agent-* session is a child of the current orchestrator.
  // Close finished sub-agents before adding another. They cost a terminal pane
  // and a live process each, and an orchestrator working through a task tends
  // to leave a trail of them sitting idle at their REPL.
  const parentId = isSubagent ? orchestratorId() : null
  if (parentId) {
    const reaped = reapIdleSubagents(parentId)
    if (reaped.length) console.log(`reaped ${reaped.length} idle sub-agent(s) before spawn`)
  }
  const session = startSession({
    cwd: invocation.cwd ?? config.workspace,
    invocation,
    kind: isSubagent ? 'subagent' : 'command',
    parentId,
    role: isSubagent ? profile!.id : null,
  })
  return { id: session.id, label: invocation.label }
}
