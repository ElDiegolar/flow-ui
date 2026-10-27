/**
 * The team's own scripts and CLIs, declared in flow.config.json `commands`.
 * Flow does not know what they do: it lists them (to the UI and to the
 * orchestrator) and runs one as a PTY session with `sh -c <run>`, cwd = the
 * repo (scope "repo") or the workspace root (scope "workspace"). The child gets
 * FLOW_WORKSPACE, FLOW_CATEGORY, FLOW_REPO and FLOW_REPO_PATH so one script can
 * serve every repo. See examples/README.md.
 */
import { existsSync } from 'node:fs'
import { resolveRepoPath } from './common/project.ts'
import type { FlowCommand, FlowConfig, Invocation } from './common/types.ts'

/** A request problem; `status` is the HTTP code the caller should return. */
export class CommandError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

export function findCommand(config: FlowConfig, id: string): FlowCommand | undefined {
  return config.commands.find((c) => c.id === id)
}

/** Whether a command runs for this category (repo scope only; null filter = all). */
function appliesTo(cmd: FlowCommand, category: string): boolean {
  if (cmd.scope === 'workspace') return true
  if (!cmd.categories) return true
  const want = category.toLowerCase()
  return cmd.categories.some((c) => c.toLowerCase() === want)
}

/**
 * The commands runnable in this context. Workspace commands always; repo
 * commands only once both category and repo are given and the category passes
 * the command's filter. With no context, only workspace commands are listed.
 */
export function listCommands(config: FlowConfig, category?: string, repo?: string): FlowCommand[] {
  const haveRepo = Boolean(category && repo)
  return config.commands.filter((c) => {
    if (c.scope === 'workspace') return true
    return haveRepo && appliesTo(c, category!)
  })
}

/**
 * The spawn recipe for one configured command. Throws CommandError for an
 * unknown id (400), a repo command without category/repo or outside its
 * category filter (400), or a repo that does not exist (400). The workspace is
 * checked by the caller.
 */
export function buildCommandInvocation(
  config: FlowConfig,
  id: string,
  category?: string,
  repo?: string,
): Invocation {
  const cmd = findCommand(config, id)
  if (!cmd) throw new CommandError(400, `unknown command: ${id}`)
  if (!config.workspace)
    throw new CommandError(409, 'no workspace yet: run AI Setup or set FLOW_WORKSPACE')
  const workspace = config.workspace

  let cwd: string = workspace
  let repoPath = ''
  let where = 'workspace'
  if (cmd.scope === 'repo') {
    if (!category || !repo) throw new CommandError(400, `command "${id}" needs category and repo`)
    if (!appliesTo(cmd, category))
      throw new CommandError(400, `command "${id}" does not apply to category "${category}"`)
    const dir = resolveRepoPath(config, category, repo)
    if (!dir || !existsSync(dir)) throw new CommandError(400, 'repo not found')
    cwd = dir
    repoPath = dir
    where = `${category}/${repo}`
  }

  return {
    command: 'sh',
    args: ['-c', cmd.run],
    prompts: [],
    cwd,
    label: `${cmd.label} — ${where}`,
    env: {
      FLOW_WORKSPACE: workspace,
      FLOW_CATEGORY: cmd.scope === 'repo' ? (category ?? '') : '',
      FLOW_REPO: cmd.scope === 'repo' ? (repo ?? '') : '',
      FLOW_REPO_PATH: repoPath,
    },
  }
}
