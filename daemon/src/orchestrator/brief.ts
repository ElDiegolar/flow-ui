/**
 * The orchestrator's system brief and its MCP tool allowlists.
 */
import { allProfiles } from '../models.ts'
import { graphStatus, graphifyBin } from '../codeGraph.ts'
import { getSettings } from '../settings.ts'
import { listProjects } from '../common/project.ts'
import { skillsReport } from '../skills.ts'
import type { FlowConfig } from '../common/types.ts'

/**
 * MCP tools the orchestrator may call WITHOUT a permission prompt. Anything
 * destructive (git_commit, kill_session) is deliberately left off this list so
 * Claude Code surfaces a permission prompt in the terminal, which the user
 * approves or denies. Keep in sync with the tools in `daemon/src/mcp/flowMcp.ts`.
 */
export const ORCHESTRATOR_SAFE_TOOLS = [
  'mcp__flow__list_projects',
  'mcp__flow__list_sessions',
  'mcp__flow__read_session',
  'mcp__flow__wait_for_session',
  'mcp__flow__send_input',
  'mcp__flow__run_agent',
  'mcp__flow__task_list',
  'mcp__flow__task_create',
  'mcp__flow__jira_set_boards',
  'mcp__flow__record_learning',
  'mcp__flow__list_skills',
  'mcp__flow__read_skill',
  'mcp__flow__harness_status',
  'mcp__flow__list_learnings',
  'mcp__flow__task_update',
  'mcp__flow__active_context',
  'mcp__flow__git_branch',
  // Configured commands. The daemon itself refuses a confirm-marked command
  // unless confirmed:true is sent (routes via sessions.ts), so it is safe here.
  'mcp__flow__list_commands',
  // Jira and Figma are reached through the DAEMON's single connection to each
  // (see integrations/hub.ts), never through an atlassian/figma server of the
  // orchestrator's own — that per-restart mcp-remote was what kept opening
  // OAuth windows. jira_call enforces the read-only setting server-side, so
  // it can sit on this list: a write while read-only is refused, not prompted.
  'mcp__flow__jira_status',
  'mcp__flow__jira_list_tools',
  'mcp__flow__jira_call',
  'mcp__flow__jira_sync_board',
  'mcp__flow__figma_list_tools',
  'mcp__flow__figma_call',
]

// Workflow rules live HERE, once. Tool descriptions say only what a tool does
// and returns — both are in context every turn, so a rule written in both
// places is paid for twice.
const ORCHESTRATOR_BRIEF_BASE = [
  'You are the Flow orchestrator: the control agent for this workspace.',
  'Drive Flow ONLY through the `flow` MCP tools. Never edit files under the workspace yourself.',
  '',
  'DELEGATE. You plan, delegate, watch and report; every change, fix, build or test is done',
  'by a sub-agent you start with run_agent on the right project/repo. Querying (list_*,',
  'read_session) is fine; if a request needs any change, your first action is run_agent.',
  'Sub-agents get full read/write on their repo and run auto-approved.',
  '',
  'DRIVING SUB-AGENTS. After starting any command or sub-agent, loop wait_for_session →',
  '(on "awaiting-input": read it, answer with send_input) → wait_for_session until it exits.',
  'Never poll read_session in a loop. Keep every live sub-agent moving; never leave one',
  'waiting for a human. Session reads return only text new since your last read.',
  '',
  'SKILLS. Workspace conventions are served by read_skill / list_skills and are NOT in your',
  'context. Read the ones that apply BEFORE planning. Sub-agents have no MCP: put what they',
  'must follow into their prompt — a name or a link is not enough.',
  '',
  'BOARD. task_list / task_create / task_update; move a task to "review" when a sub-agent has',
  'finished and the human should look. Starting, parking and resuming tasks restart you —',
  'the human does those.',
  '',
  'DESTRUCTIVE (git_commit, kill_session): the user is prompted to approve; say what you are',
  'about to do and why first.',
  '',
  "COMMANDS. list_commands shows the scripts this workspace configured (tests, builds, deploys); run them with run_command instead of guessing shell invocations; a command marked confirm needs the human's OK first.",
  '',
  'LEARNINGS. When you or a sub-agent had to DISCOVER something about a repo that was not',
  'written anywhere and cost real time, record_learning it while fresh, with the evidence.',
  'Not what the code shows, not what the standards say, not one-off task details.',
  '',
  'BRANCHES. The active context is the pinned repo and its branch; Diff and Commit follow it.',
  'Switch with git_branch, never by having a sub-agent run git checkout.',
  '',
  'Prefer the smallest safe action; report back concisely with session ids.',
].join('\n')

const FIGMA_SECTION = [
  'FIGMA (figma_list_tools / figma_call, via the running Figma Desktop app). When a task links',
  'a design, read it BEFORE delegating (get_design_context, get_screenshot) and put the',
  "specifics (spacing, colours, components) in the sub-agent's prompt — it cannot open Figma.",
  'With no link, omit nodeId: Figma uses the frame the human has selected. get_design_context',
  "saves the frame's assets to the Figma assets folder (~/figma-assets by default, outside",
  'every project); give the sub-agent those paths to copy into their standard homes.',
  'If figma_call errors, Figma Desktop is not running: say so, do not guess.',
].join('\n')

const CODE_GRAPH_SECTION = [
  'CODE GRAPH (code_graph_status / code_graph_build / code_graph_ask). Repos can carry a',
  'pre-built symbol graph (calls, imports, inherits, file:line per node; local, no LLM).',
  'Before delegating work on an unfamiliar area, code_graph_ask the pinned repo and put the',
  'exact files and symbols it names into the sub-agent prompt — a sub-agent that is told',
  'where the code is reads a few files instead of grepping the repo. Sub-agents can run the',
  'same queries from the shell; their prompt tells them how. If status says no graph,',
  'code_graph_build it once (minutes on a large repo) and refresh it after a task that',
  'moved code around. When the human asks for graphs to be built, code_graph_build the repo,',
  'the category (omit repo) or everything (all: true), then report code_graph_status when',
  'bulk.running is false. The graph does not see config arrays, Blade templates or lang keys.',
].join('\n')

const JIRA_SECTION = [
  "JIRA (jira_status / jira_list_tools / jira_call / jira_sync_board, via the daemon's one",
  'Atlassian login). If jira_status says disconnected, tell the human to Connect under Setup;',
  'never authenticate yourself. The board syncs itself — do not import issues or create tasks',
  'for them. jira_call runs any Atlassian tool by name (most need the cloudId from',
  'jira_status). Read freely; write only when asked (writes are refused while read-only).',
].join('\n')

export type BriefPin = {
  category: string
  repo: string
  repoPath: string | null
  /** Standards bodies governing the repo, already resolved. */
  standards: string[]
}

/**
 * The orchestrator brief: the rules, plus everything the daemon already knows
 * baked in so the agent never spends a turn or a tool call re-deriving it — the
 * workspace names (was a mandatory list_projects call), the model profiles, and
 * for a pinned project its path, standards and matching skills (was a seeded
 * "acknowledge the pin" turn plus a mandatory list_skills call). Jira/Figma
 * guidance only appears while that integration is switched on.
 */
export function buildOrchestratorBrief(
  config: FlowConfig,
  pin?: BriefPin,
  /** Project context files for engines/models that don't load them (projectContext.ts). */
  context?: string,
): string {
  const settings = getSettings()
  const projects = listProjects(config)
  const lines = projects.map((p) => {
    const repos = p.repos.length ? p.repos.join(', ') : '(no repos yet)'
    return `- ${p.name}: ${repos}`
  })
  const out = [ORCHESTRATOR_BRIEF_BASE]
  if (settings.figma.enabled) out.push('', FIGMA_SECTION)
  if (settings.atlassian.enabled) out.push('', JIRA_SECTION)
  if (graphifyBin()) out.push('', CODE_GRAPH_SECTION)
  out.push(
    '',
    config.workspace
      ? `The workspace is \`${config.name}\` at \`${config.workspace}\`; repos are \`projects/<category>/<repo>\`.`
      : 'There is no workspace yet. Tell the developer to run AI Setup in Setup; do not guess paths.',
    '',
    'PROJECTS at session start — exact category/repo names for tools (list_projects only to',
    'catch a new repo since):',
    ...(lines.length ? lines : ['- (no project categories found)']),
    '',
    'MODELS — run_agent `agent` ids:',
    ...allProfiles(settings.models).map(
      (p) =>
        `- ${p.id}: ${p.label} (${p.engine}${p.model ? `, ${p.model}` : ''})` +
        (p.id === settings.subagentDefault ? ' — default' : ''),
    ),
  )
  if (pin) {
    out.push('', ...pinSection(config, pin))
  } else {
    out.push('', 'No project is pinned: on project work, call list_skills first.')
  }
  if (context) out.push('', context)
  return out.join('\n')
}

/**
 * What the orchestrator is told about its pinned project: path, matching
 * skills, governing standards. Part of the brief at start, and typed in as-is
 * when the pin moves on a live session (orchestrator/index.ts repinOrchestrator).
 */
export function pinSection(config: FlowConfig, pin: BriefPin): string[] {
  const skills = skillsReport(config, pin.category, pin.repo).skills.filter(
    (sk) => sk.matchesCategory || !sk.category,
  )
  const out = [
    `PINNED PROJECT: ${pin.category}/${pin.repo}` +
      (pin.repoPath ? ` (${pin.repoPath})` : '') +
      ' — the working context for run_agent unless told otherwise.',
    skills.length
      ? 'Skills for it (read_skill the ones that apply; list_skills for the rest):'
      : 'No skills are named for it; list_skills shows the full set.',
    ...skills.map((sk) => `- ${sk.name}: ${oneLine(sk.description)}`),
  ]
  if (graphifyBin()) {
    const g = graphStatus(pin.category, pin.repo)
    out.push(
      g.built
        ? `Code graph: built (${g.nodes} nodes, ${g.edges} edges) — code_graph_ask it before delegating.`
        : 'Code graph: not built — code_graph_build it before the first delegation.',
    )
  }
  if (pin.standards.length)
    out.push(
      '',
      `Standards governing ${pin.category}/${pin.repo} — hold every sub-agent on it to them:`,
      '',
      ...pin.standards,
    )
  return out
}

/** First sentence of a skill description, capped — enough to pick it by. */
function oneLine(text: string): string {
  const flat = text
    .replace(/^>-?\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  const first = flat.match(/^.*?[.!?](\s|$)/)?.[0]?.trim() ?? flat
  return first.length > 160 ? `${first.slice(0, 157)}…` : first
}
