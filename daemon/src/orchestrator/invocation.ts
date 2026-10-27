/**
 * How the long-lived orchestrator session is launched.
 */
import { existsSync } from 'node:fs'
import { CODEX_AUTONOMY_ARGS, resolveCodex } from '../common/agents.ts'
import { resolveRepoPath } from '../common/project.ts'
import type { FlowConfig, Invocation } from '../common/types.ts'
import { profileLaunch, type ModelProfile } from '../models.ts'
import { buildOrchestratorBrief, ORCHESTRATOR_SAFE_TOOLS, type BriefPin } from './brief.ts'

/** Resolved flow MCP server descriptor, shared by the claude (JSON config)
 * and codex (`-c` overrides) orchestrator wiring. */
export type McpServer = { command: string; args: string[]; env: Record<string, string> }
export type OrchestratorMcp = {
  /** Path to the claude `--mcp-config` JSON (claude path only). */
  configPath: string
  /** The flow server descriptor (codex path builds `-c mcp_servers.*` from it). */
  flow: McpServer
}

/**
 * The long-lived orchestrator session, wired to the flow MCP server. Branches
 * on the model profile's engine (the profile then picks the model/endpoint —
 * see models.ts):
 *  - claude: the local `claude` binary, brief via `--append-system-prompt`, MCP
 *    via `--mcp-config` + `--strict-mcp-config` (flow ONLY — the developer's
 *    user-scope servers stay out), and the flow tools pre-approved via
 *    `--allowedTools`.
 *  - codex: the local `codex` TUI, MCP via `-c mcp_servers.flow.*` overrides,
 *    `--full-auto` for un-prompted tool use. Codex has no system-prompt flag and
 *    no per-tool allowlist, so the brief is seeded as the first turn (by
 *    startOrchestrator).
 * Jira and Figma are NOT servers here on either path: both are reached through
 * flow's jira_call / figma_call, which use the daemon's single connection
 * and enforce Jira read-only server-side (integrations/hub.ts).
 * `prompts` is empty on the codex path. The claude path answers Claude Code's
 * the developer answers Claude's own first-run prompts (folder trust) in the pane; it is fully interactive.
 */
export function buildOrchestratorInvocation(
  config: FlowConfig,
  profile: ModelProfile,
  mcp: OrchestratorMcp,
  daemonUrl: string,
  token: string,
  extraDirs: string[] = [],
  pin?: { category: string; repo: string },
  codexHome?: string,
  briefPin?: BriefPin,
  context?: string,
): Invocation {
  if (!config.workspace) throw new Error('no workspace configured')
  const workspace = config.workspace
  const pinnedPath = pin ? resolveRepoPath(config, pin.category, pin.repo) : null
  const launch = profileLaunch(profile)
  const env = { ...launch.env, FLOW_URL: daemonUrl, FLOW_TOKEN: token }
  const name = profile.builtin ? profile.engine : profile.label

  if (profile.engine === 'codex') {
    // MCP is configured via `-c mcp_servers.<name>.*` overrides. Codex parses
    // each value as TOML: a quoted string and a string array are valid as-is, but
    // a JSON object is NOT a TOML table (Codex 0.143 rejects it with "expected a
    // map"), so the env is set with dotted keys — one string value each. No shell
    // is involved (node-pty spawns argv directly), so no extra escaping is needed.
    // cwd stays the workspace root; the pinned repo is in scope under it. The brief is
    // delivered by startOrchestrator as turn one.
    const mcpArgs = [
      '-c',
      `mcp_servers.flow.command=${JSON.stringify(mcp.flow.command)}`,
      // Auto-approve every flow tool. Codex 0.153 gates MCP tool calls on
      // their own approval mode, independent of `--ask-for-approval`: in the
      // default mode the call is queued for approval, and since the policy is
      // `never` there is nobody to approve it, so it fails outright with "MCP
      // tool call requires approval, but approval policy is never" — the
      // orchestrator then reports itself blocked (on list_skills, its first
      // call) and stops. Modes are `auto` | `prompt` | `writes` | `approve`;
      // the flow surface is the orchestrator's only way to work, so it is
      // `approve`.
      '-c',
      'mcp_servers.flow.default_tools_approval_mode="approve"',
      '-c',
      `mcp_servers.flow.args=${JSON.stringify(mcp.flow.args)}`,
      ...Object.entries(mcp.flow.env).flatMap(([k, v]) => [
        '-c',
        `mcp_servers.flow.env.${k}=${JSON.stringify(v)}`,
      ]),
    ]
    const codex = resolveCodex(config)
    return {
      label: pin ? `orchestrator (${name}) — ${pin.repo}` : `orchestrator (${name})`,
      command: codex.command,
      cwd: workspace,
      args: [
        ...codex.prefixArgs,
        '--cd',
        workspace,
        ...CODEX_AUTONOMY_ARGS,
        ...launch.args,
        ...mcpArgs,
      ],
      prompts: [],
      env: codexHome ? { ...env, CODEX_HOME: codexHome } : env,
    }
  }

  // claude
  // When pinned to a project, grant the agent direct access to that repo's dir
  // so it works in the right context without rediscovering it each time. cwd
  // stays the workspace root — the agent drives everything via the flow MCP.
  const pinnedDirArgs = pinnedPath && existsSync(pinnedPath) ? ['--add-dir', pinnedPath] : []
  return {
    label: pin ? `orchestrator (${name}) — ${pin.repo}` : `orchestrator (${name})`,
    command: config.claudeBin,
    cwd: workspace,
    args: [
      ...launch.args,
      '--add-dir',
      workspace,
      ...extraDirs.flatMap((d) => ['--add-dir', d]),
      ...pinnedDirArgs,
      '--mcp-config',
      mcp.configPath,
      // Only the servers in our config. Without this claude ALSO loads the
      // developer's user-scope servers — including their own `atlassian`
      // mcp-remote, which opened an OAuth window on every orchestrator start.
      '--strict-mcp-config',
      '--append-system-prompt',
      buildOrchestratorBrief(config, briefPin, context),
      '--allowedTools',
      ...ORCHESTRATOR_SAFE_TOOLS,
    ],
    prompts: [],
    env,
  }
}
