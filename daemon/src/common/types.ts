/**
 * Shared shapes for the daemon: the workspace config every module reads, the
 * project tree it describes, and the spawn recipe for an agent or git process.
 */

export type ProjectCategory = {
  name: string
  slug: string
  repos: string[]
}

/**
 * Resolved workspace configuration (see common/config.ts). `workspace` is null
 * when no workspace exists yet; the daemon still runs and the Setup tab offers
 * AI Setup to create one.
 */
export type FlowConfig = {
  workspace: string | null
  name: string
  projectsDir: string
  categories: string[] | null
  skillsDir: string
  standardsDir: string
  claudeBin: string
  codexBin: string
  /** Scripts the team plugs in (see commands.ts). Empty when none are configured. */
  commands: FlowCommand[]
}

/**
 * One entry of `commands` in flow.config.json. `run` is a shell string executed
 * with `sh -c`; `scope` decides its cwd (repo path or workspace root).
 */
export type FlowCommand = {
  id: string
  label: string
  run: string
  scope: 'repo' | 'workspace'
  /** Repo scope only: the categories it applies to. null = every category. */
  categories: string[] | null
  /** true = destructive: the UI asks first and the orchestrator needs confirmed:true. */
  confirm: boolean
}

/** The agent CLI a model profile runs through (see models.ts). */
export type Engine = 'claude' | 'codex'

/**
 * Resolved description of a process to spawn in a PTY. Each entry in `prompts`
 * tells the PTY driver what to type once a specific prompt appears. If
 * `prompts` is empty, the command runs straight through (interactive).
 */
export type Invocation = {
  args: string[]
  prompts: PromptAnswer[]
  label: string
  cwd?: string
  /** Executable to spawn. */
  command: string
  /** Extra environment variables merged into the PTY's env. */
  env?: Record<string, string>
}

export type PromptAnswer = {
  /** Substring of the prompt to match against PTY output. */
  match: string
  /** What to type once the prompt appears. Tabs are sent as raw '\t' for multi-select. */
  type: string
  /** Optional second pass: select all matching after typing (used with multi-select). */
  selectAll?: boolean
}
