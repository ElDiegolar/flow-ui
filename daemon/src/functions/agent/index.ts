/**
 * Per-repo coding sub-agents. Each one is a plain CLI process (claude or codex)
 * started in the repo's own directory, with the workspace added so shared
 * skills and AGENTS.md stay readable.
 */
import { agentAutonomyArgs, codexHome, resolveCodex } from '../../common/agents.ts'
import { resolveRepoPath } from '../../common/project.ts'
import type { FlowConfig, Invocation } from '../../common/types.ts'
import { profileLaunch, type ModelProfile } from '../../models.ts'
import { codeGraphPrompt } from '../../codeGraph.ts'
import { projectContext } from '../../projectContext.ts'
import { withStandards } from '../../standards.ts'

export function buildAgentInvocation(
  profile: ModelProfile,
  config: FlowConfig,
  category?: string,
  repo?: string,
  initialPrompt?: string,
): Invocation {
  if (!config.workspace) throw new Error('no workspace configured')
  const cwd = resolveRepoPath(config, category, repo) ?? config.workspace
  const atRepo = cwd !== config.workspace
  const where = atRepo ? `${category}/${repo}` : 'workspace root'
  // Any standards governing this repo lead the opening turn, so the agent has
  // them before it writes a line rather than discovering them at review.
  const standardsPrompt = withStandards(config, initialPrompt, category, repo)
  // A custom model gets the workspace + repo context files up front (see
  // projectContext.ts); built-ins rely on their CLI's own discovery.
  const context = profile.builtin
    ? ''
    : projectContext(config, profile.engine, cwd, atRepo ? cwd : null)
  // A pre-built code graph (codeGraph.ts) lets the agent locate code by asking
  // the graph instead of grepping; the paragraph is empty when there is none.
  const graph = codeGraphPrompt(category, repo)
  const prompt = [context, standardsPrompt, graph].filter(Boolean).join('\n\n') || undefined
  // A custom profile adds its model/endpoint; the built-ins launch with their
  // CLI defaults.
  const launch = profile.builtin ? { args: [], env: {} } : profileLaunch(profile)
  const name = profile.builtin ? profile.engine : profile.label

  if (profile.engine === 'codex') {
    // Codex is spawned directly and pointed at the repo with --cd.
    const codex = resolveCodex(config)
    const args = [...codex.prefixArgs, '--cd', cwd, ...agentAutonomyArgs('codex'), ...launch.args]
    if (prompt) args.push(prompt)
    return {
      label: `agent ${name} — ${where}`,
      command: codex.command,
      args,
      prompts: [],
      cwd,
      env: { ...launch.env, CODEX_HOME: codexHome() },
    }
  }

  // `--strict-mcp-config` with no `--mcp-config` = no MCP servers at all, so a
  // sub-agent does not inherit the developer's user-scope servers. `--add-dir`
  // is variadic, so `--` ends it before the prompt.
  const args: string[] = [
    ...agentAutonomyArgs('claude'),
    '--strict-mcp-config',
    '--add-dir',
    config.workspace,
    ...launch.args,
  ]
  if (prompt) args.push('--', prompt)
  return {
    label: `agent ${name} — ${where}`,
    command: config.claudeBin,
    args,
    prompts: [],
    cwd,
    env: launch.env,
  }
}
