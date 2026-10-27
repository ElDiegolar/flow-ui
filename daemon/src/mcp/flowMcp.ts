/**
 * flow MCP server (stdio).
 *
 * Launched by the orchestrator's `claude` process (see
 * `buildOrchestratorInvocation` in ../orchestrator/invocation.ts). Every tool is a thin
 * HTTP call to the Flow daemon's existing API — this server holds NO
 * business logic, it just gives the orchestrator a typed, safe tool surface.
 *
 * Auth: the daemon URL + one-time token arrive via env (FLOW_URL,
 * FLOW_TOKEN), injected when the orchestrator session is spawned.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const BASE = process.env.FLOW_URL ?? 'http://127.0.0.1:8765'
const TOKEN = process.env.FLOW_TOKEN ?? ''

type Json = Record<string, unknown>

async function apiFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers)
  headers.set('X-Flow-Token', TOKEN)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${text}`)
  }
  return text ? JSON.parse(text) : null
}

const get = (path: string) => apiFetch(path)
const post = (path: string, body: Json) =>
  apiFetch(path, { method: 'POST', body: JSON.stringify(body) })
const put = (path: string, body: Json) =>
  apiFetch(path, { method: 'PUT', body: JSON.stringify(body) })
const del = (path: string) => apiFetch(path, { method: 'DELETE' })

/** Wrap a plain JSON result in the MCP text-content envelope. Compact: every
 * character here lands in the agent's context, indentation included. */
function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}

// Per-session read cursor, so read_session / wait_for_session return only what
// is new since this agent last looked (sessionText.ts renders + trims it).
const cursors = new Map<string, number>()
// Last text sent per session: a re-read of an unchanged screen says so instead
// of repeating it.
const lastText = new Map<string, string>()
async function readText(path: string, id: string, fromStart?: boolean, body?: Json) {
  const since = fromStart ? 0 : (cursors.get(id) ?? 0)
  const url = `${path}?view=text&since=${since}`
  const res = (body ? await post(url, body) : await get(url)) as {
    cursor?: number
    text?: string
  }
  if (typeof res?.cursor === 'number') cursors.set(id, res.cursor)
  if (typeof res?.text === 'string') {
    if (!fromStart && res.text === lastText.get(id)) res.text = '(no new output)'
    else lastText.set(id, res.text)
  }
  return res
}

const server = new McpServer({ name: 'flow', version: '0.1.0' })

// The exact names are in the brief's workspace list; no need to repeat that here
// on every tool that takes them.
const category = z.string().describe('Project category.')
const repo = z.string().describe('Repo within the category.')

// Tools for an integration that is switched off in Setup are not offered at all:
// each definition costs context on every turn, for a tool that can only fail.
const JIRA_TOOLS = [
  'jira_set_boards',
  'jira_status',
  'jira_list_tools',
  'jira_call',
  'jira_sync_board',
]
const FIGMA_TOOLS = ['figma_list_tools', 'figma_call']
const OFF = new Set([
  ...(process.env.FLOW_MCP_JIRA === '0' ? JIRA_TOOLS : []),
  ...(process.env.FLOW_MCP_FIGMA === '0' ? FIGMA_TOOLS : []),
])
const registerTool = server.registerTool.bind(server) as (...args: unknown[]) => { remove(): void }
server.registerTool = ((...args: unknown[]) => {
  const tool = registerTool(...args)
  if (OFF.has(args[0] as string)) tool.remove()
  return tool
}) as unknown as typeof server.registerTool

// --- Read / inspect (safe) ------------------------------------------------
server.registerTool(
  'list_projects',
  {
    title: 'List projects',
    description: 'List every project category in the workspace and its repos.',
    inputSchema: {},
  },
  async () => ok(await get('/api/projects')),
)

server.registerTool(
  'task_list',
  {
    title: 'List Flow tasks',
    description:
      'List the tasks on the Flow board (id, title, status, jiraKey, category/repo). ' +
      'Only open work: tasks done or gone in Jira are cleared by the board sync.',
    inputSchema: {},
  },
  async () => ok(await get('/api/tasks')),
)

server.registerTool(
  'task_create',
  {
    title: 'Create a Flow task',
    description: 'Create one task on the board. Set category/repo when known.',
    inputSchema: {
      title: z.string().describe('Short task title (e.g. the Jira issue summary).'),
      description: z.string().optional().describe('Details / acceptance criteria.'),
      jiraUrl: z.string().optional().describe('Link to the Jira issue, if it came from Jira.'),
      category: z.string().optional().describe('Project category, as listed by list_projects.'),
      repo: z.string().optional().describe('Repo within the category, as listed by list_projects.'),
    },
  },
  async (args) => ok(await post('/api/tasks', args as Json)),
)

// --- The harness itself: skills, and its own state (safe) -----------------
server.registerTool(
  'list_skills',
  {
    title: 'List the skills available for this project',
    description:
      'List the workspace skills and injected standards (defaults to the pinned project). Read the ones that apply with read_skill.',
    inputSchema: {
      category: z.string().optional().describe('Defaults to the pinned project.'),
      repo: z.string().optional().describe('Defaults to the pinned project.'),
    },
  },
  async ({ category, repo }) => {
    const q =
      category && repo
        ? `?category=${encodeURIComponent(category)}&repo=${encodeURIComponent(repo)}`
        : ''
    return ok(await get(`/api/skills${q}`))
  },
)

server.registerTool(
  'read_skill',
  {
    title: 'Read a skill in full',
    description:
      "A skill's whole SKILL.md plus every reference document it ships. Use it when " +
      'list_skills shows one relevant to the work — the description alone is a summary, ' +
      'the rules are in the body. When you delegate, pass the parts that matter into the ' +
      "sub-agent's prompt: a sub-agent has no MCP tools and cannot read this itself.",
    inputSchema: { name: z.string().describe('Skill name exactly as list_skills reports it.') },
  },
  async ({ name }) => ok(await get(`/api/skills/${encodeURIComponent(name)}`)),
)

server.registerTool(
  'harness_status',
  {
    title: 'Read the harness state',
    description:
      'Which agents/MCP servers are configured or missing, and how far each repo is behind its remote. For failures that look like setup.',
    inputSchema: {},
  },
  async () => ok({ setup: await get('/api/setup'), sync: await get('/api/sync') }),
)

server.registerTool(
  'list_learnings',
  {
    title: 'List recorded learnings',
    description:
      'Learnings recorded on earlier work, with their review status. The reviewed ones ' +
      'are already in your context; this shows the full set including unreviewed and ' +
      'discarded, so you can check whether something has been tried before.',
    inputSchema: {},
  },
  async () => ok(await get('/api/learnings')),
)

server.registerTool(
  'task_update',
  {
    title: 'Update a task on the board',
    description:
      "Move a task's status as work progresses — e.g. to 'review' when a sub-agent has " +
      "finished and the human should look, or 'done' once they have. Statuses: todo, " +
      'in_progress, parked, review, done. Starting, parking and resuming a task are NOT ' +
      'available to you: each restarts the orchestrator, which would kill this session ' +
      'mid-call. The human drives those from the Tasks tab.',
    inputSchema: {
      id: z.string().describe('Task id from task_list.'),
      status: z.enum(['todo', 'in_progress', 'parked', 'review', 'done']).describe('New status.'),
    },
  },
  async ({ id, status }) =>
    ok(
      await apiFetch(`/api/tasks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
    ),
)

server.registerTool(
  'record_learning',
  {
    title: 'Record a learning about a repo',
    description:
      'Record something about a repo that was not written anywhere and cost real time to discover (see Learnings in your brief). A human reviews it.',
    inputSchema: {
      title: z.string().describe('One line, e.g. "Vitest needs --pool=forks in this repo".'),
      body: z
        .string()
        .describe('What the rule is, and the evidence that established it. A short paragraph.'),
      category: z.string().optional().describe('Project category it applies to, if repo-specific.'),
      repo: z.string().optional().describe('Repo it applies to. Omit both for workspace-wide.'),
      source: z.string().optional().describe('Where it came from, e.g. the task or session id.'),
    },
  },
  async (args) => ok(await post('/api/learnings', args as Json)),
)

server.registerTool(
  'jira_set_boards',
  {
    title: "Report the user's Jira boards",
    description:
      'Replace the stored list of Jira boards where the user has assigned, not-done work (one entry per board, across Atlassian sites), so the user can pick one to sync.',
    inputSchema: {
      boards: z
        .array(
          z.object({
            key: z.string().describe('Project/board key, e.g. "STL".'),
            name: z.string().optional().describe('Human-readable project/board name.'),
            site: z.string().optional().describe('Atlassian site host, e.g. acme.atlassian.net.'),
            cloudId: z.string().optional().describe('Atlassian cloudId for the site.'),
            url: z.string().optional().describe('Link to the board/project.'),
            issueCount: z.number().optional().describe('Assigned not-done issues there.'),
          }),
        )
        .describe('All boards where the user has assigned work.'),
    },
  },
  async (args) => ok(await put('/api/jira/boards', args as Json)),
)

server.registerTool(
  'list_sessions',
  {
    title: 'List sessions',
    description: 'List all command/agent sessions the daemon is tracking (running and exited).',
    inputSchema: {},
  },
  async () => ok(await get('/api/sessions')),
)

server.registerTool(
  'read_session',
  {
    title: 'Read session output',
    description:
      'Peek at a session now, without waiting: its terminal text since your last read, plus ' +
      'exit state. To wait for it, use wait_for_session instead of calling this in a loop.',
    inputSchema: {
      id: z.string().describe('Session id returned by a launch/create/run tool.'),
      fromStart: z.boolean().optional().describe('Re-read from the start (tail-capped).'),
    },
  },
  async ({ id, fromStart }) =>
    ok(await readText(`/api/sessions/${encodeURIComponent(id)}/replay`, id, fromStart)),
)

server.registerTool(
  'wait_for_session',
  {
    title: 'Wait for a session',
    description:
      'Block until a session exits or needs input, then return its terminal text since your last read and its exit state. outcome: "exited" | "awaiting-input" (answer with send_input) | "timeout" (call again).',
    inputSchema: {
      id: z.string().describe('Session id returned by a launch/create/run tool.'),
      timeoutMs: z
        .number()
        .optional()
        .describe('How long to wait before returning "timeout" (default 120000, max 180000).'),
      until: z
        .enum(['exit', 'exit-or-input'])
        .optional()
        .describe(
          'Return as soon as the session blocks on input too (default), or only on exit. ' +
            'Use "exit" for non-interactive commands.',
        ),
    },
  },
  async ({ id, timeoutMs, until }) =>
    ok(
      await readText(`/api/sessions/${encodeURIComponent(id)}/wait`, id, false, {
        timeoutMs,
        until,
      }),
    ),
)

server.registerTool(
  'send_input',
  {
    title: 'Send input to a session',
    description:
      "Type into a session's terminal to drive a sub-agent; submits with Enter unless enter:false. Use bracketedPaste:true for multi-line text.",
    inputSchema: {
      id: z.string().describe('Session id of the sub-agent (from run_agent / list_sessions).'),
      text: z
        .string()
        .describe('The text to type, e.g. the next instruction or a prompt answer like "1".'),
      enter: z.boolean().optional().describe('Press Enter to submit after typing (default true).'),
      bracketedPaste: z
        .boolean()
        .optional()
        .describe('Wrap as a bracketed paste — use for multi-line text (default false).'),
    },
  },
  async ({ id, text, enter, bracketedPaste }) =>
    ok(
      await post(`/api/sessions/${encodeURIComponent(id)}/input`, {
        text,
        enter,
        bracketedPaste,
      }),
    ),
)

// --- Configured commands (flow.config.json `commands`) ---------------------
server.registerTool(
  'list_commands',
  {
    title: 'List the configured commands',
    description:
      'The scripts this workspace configured (tests, builds, deploys), each with id, label, ' +
      "scope and confirm. Pass category and repo to include that repo's commands; with neither, " +
      'only workspace-scope commands are listed.',
    inputSchema: {
      category: z.string().optional().describe('Project category, as listed by list_projects.'),
      repo: z.string().optional().describe('Repo within the category.'),
    },
  },
  async ({ category, repo }) => {
    const q = new URLSearchParams()
    if (category) q.set('category', category)
    if (repo) q.set('repo', repo)
    const qs = q.toString()
    return ok(await get(`/api/commands${qs ? `?${qs}` : ''}`))
  },
)

// --- Start commands (safe) ------------------------------------------------
server.registerTool(
  'run_agent',
  {
    title: 'Run sub-agent',
    description:
      'Spawn a per-repo coding sub-agent on a project/repo with an optional initial prompt. Omit ' +
      'category/repo to run at the workspace root. Returns a session { id, label }.',
    inputSchema: {
      agent: z
        .string()
        .optional()
        .describe(
          "Model profile id — 'codex', 'claude', or a custom one listed in your brief. " +
            "Omit to use the developer's default.",
        ),
      category: category.optional(),
      repo: repo.optional(),
      prompt: z.string().optional().describe('Initial task prompt for the sub-agent.'),
    },
  },
  async ({ agent, category, repo, prompt }) =>
    ok(
      await post('/api/sessions', {
        command: 'agent',
        profile: agent,
        category,
        repo,
        prompt,
      }),
    ),
)

server.registerTool(
  'run_command',
  {
    title: 'Run a configured command',
    description:
      "Run one of the workspace's configured commands (list_commands shows them) in a repo or the " +
      'workspace; returns a session id to wait_for_session on. A command with confirm: true is ' +
      'refused unless confirmed is true: set it only after the human has agreed to that command.',
    inputSchema: {
      id: z.string().describe('Command id from list_commands.'),
      category: category.optional().describe('Required for a repo-scope command.'),
      repo: repo.optional().describe('Required for a repo-scope command.'),
      confirmed: z
        .boolean()
        .optional()
        .describe('true only after the human agreed to run a confirm command.'),
    },
  },
  async ({ id, category, repo, confirmed }) =>
    ok(
      await post('/api/sessions', {
        command: 'run',
        id,
        category,
        repo,
        confirmed,
      }),
    ),
)

// --- Destructive (NOT in --allowedTools → Claude Code will prompt) ---------

server.registerTool(
  'git_commit',
  {
    title: 'Git commit',
    description:
      'DESTRUCTIVE. Stage everything in a repo (git add -A) and commit it with the message you give. ' +
      'Returns a session { id, label }. Say what you are committing and why before calling it.',
    inputSchema: {
      category,
      repo,
      message: z.string().min(1).describe('The commit message.'),
    },
  },
  async ({ category, repo, message }) =>
    ok(await post('/api/sessions', { command: 'git-commit', category, repo, message })),
)

server.registerTool(
  'kill_session',
  {
    title: 'Kill session',
    description: 'DESTRUCTIVE. Stop a running session (sends SIGINT) by its id.',
    inputSchema: { id: z.string().describe('Session id to stop.') },
  },
  async ({ id }) => ok(await del(`/api/sessions/${encodeURIComponent(id)}`)),
)

// --- Active context + branches (safe) ------------------------------------
server.registerTool(
  'active_context',
  {
    title: 'The active context',
    description:
      'The pinned project and the branch its repo is on right now — what the Diff and Commit ' +
      'tabs are showing the human. Returns { category, repo, branch, key }.',
    inputSchema: {},
  },
  async () => ok(await get('/api/context')),
)

server.registerTool(
  'git_branch',
  {
    title: 'Switch a repo to a branch',
    description:
      'Check out a branch (default: pinned repo) and fast-forward it from origin. Refuses on uncommitted changes; create:true starts a new local branch.',
    inputSchema: {
      branch: z.string().describe('Branch name, e.g. "feature/ABC-123-login".'),
      create: z
        .boolean()
        .optional()
        .describe('Create it if it exists neither locally nor on origin.'),
      category: category.optional(),
      repo: repo.optional(),
    },
  },
  async (args) => ok(await post('/api/git/branch', args as Json)),
)

// --- Jira, through the daemon's single Atlassian connection ---------------
server.registerTool(
  'jira_status',
  {
    title: 'Jira connection status',
    description:
      'Whether the daemon is connected to Atlassian, the Jira sites (with cloudId) this login ' +
      'can read, the selected board, whether Jira is read-only, and the last board sync.',
    inputSchema: {},
  },
  async () => ok(await get('/api/jira/status')),
)

server.registerTool(
  'jira_list_tools',
  {
    title: 'List the Atlassian tools',
    description:
      'Every Atlassian tool jira_call can run, with its input schema and whether it writes.',
    inputSchema: {},
  },
  async () => ok(await get('/api/jira/tools')),
)

server.registerTool(
  'jira_call',
  {
    title: 'Call an Atlassian tool',
    description:
      'Run one Atlassian (Jira/Confluence) tool by name through the daemon — e.g. ' +
      'searchJiraIssuesUsingJql { cloudId, jql, maxResults } or getJiraIssue { cloudId, ' +
      'issueIdOrKey }. Writes are refused while Jira is read-only.',
    inputSchema: {
      tool: z.string().describe('Tool name, as listed by jira_list_tools.'),
      args: z.record(z.unknown()).optional().describe("The tool's arguments."),
    },
  },
  async ({ tool, args }) =>
    (await post('/api/jira/call', { tool, args: (args ?? {}) as Json })) as {
      content: Array<{ type: 'text'; text: string }>
    },
)

server.registerTool(
  'jira_sync_board',
  {
    title: 'Sync the task board from Jira',
    description:
      'Re-sync the task board from the selected Jira board now: open issues become tasks, done ' +
      'or removed ones are cleared. It also runs by itself every few minutes.',
    inputSchema: {},
  },
  async () => ok(await post('/api/jira/sync', {})),
)

// --- Figma, through the daemon ---------------------------------------------
// --- Code graph (codeGraph.ts) --------------------------------------------
server.registerTool(
  'code_graph_status',
  {
    title: 'Code graph status for a repo',
    description:
      'Whether repos have a pre-built code graph (see CODE GRAPH in your brief): size, age, ' +
      'build running. Omit category and repo for every graph plus bulk progress.',
    inputSchema: { category: category.optional(), repo: repo.optional() },
  },
  async ({ category, repo }) =>
    ok(
      await get(
        category && repo
          ? `/api/code-graph/status?category=${encodeURIComponent(category)}&repo=${encodeURIComponent(repo)}`
          : '/api/code-graph/status',
      ),
    ),
)

server.registerTool(
  'code_graph_build',
  {
    title: 'Build or refresh the code graph for a repo',
    description:
      'Build or refresh one repo (category + repo), a whole category (omit repo), or everything ' +
      '(all: true). Bulk runs one repo at a time in the background; poll code_graph_status until ' +
      'bulk.running is false. Local, no LLM; returns at once.',
    inputSchema: {
      category: category.optional(),
      repo: repo.optional(),
      all: z.boolean().optional().describe('Every repo in every category.'),
      force: z.boolean().optional().describe('Full rebuild; use after large deletions or renames.'),
    },
  },
  async (args) => ok(await post('/api/code-graph/build', args as Json)),
)

server.registerTool(
  'code_graph_ask',
  {
    title: 'Ask the code graph',
    description:
      "Locate code in a repo's graph instead of reading files. kind=query: natural-language " +
      'question → the subgraph that matches, every node with file:line. kind=path: how symbol ' +
      '`from` reaches `to`. kind=explain: one symbol and its neighbours. kind=affected: what ' +
      'depends on `node` (reverse traversal). exit 3 = ambiguous name (candidates listed, retry ' +
      'with the id), exit 4 = no match. Use it to name the exact files in a sub-agent prompt.',
    inputSchema: {
      category,
      repo,
      kind: z.enum(['query', 'path', 'explain', 'affected']),
      question: z.string().optional().describe('For query.'),
      from: z.string().optional().describe('For path: start symbol.'),
      to: z.string().optional().describe('For path: end symbol.'),
      node: z.string().optional().describe('For explain / affected: the symbol or file.'),
      budget: z.number().optional().describe('For query: output token cap (default 2000).'),
      depth: z.number().optional().describe('For affected: traversal depth (default 2).'),
    },
  },
  async (args) => ok(await post('/api/code-graph/ask', args as Json)),
)

server.registerTool(
  'figma_list_tools',
  {
    title: 'List the Figma tools',
    description: 'Every Figma Desktop tool figma_call can run, with its input schema.',
    inputSchema: {},
  },
  async () => ok(await get('/api/figma/tools')),
)

server.registerTool(
  'figma_call',
  {
    title: 'Call a Figma Desktop tool',
    description:
      'Run one Figma Desktop tool by name — e.g. get_design_context { nodeId } or ' +
      'get_screenshot { nodeId } (nodeId from the Figma URL, "1:23"). Omit nodeId to use the ' +
      "frame selected in Figma Desktop. get_design_context saves the frame's assets to the " +
      'Figma assets folder (default ~/figma-assets, outside every project); copy the ones ' +
      'you use into the repo. Images come back to you as content.',
    inputSchema: {
      tool: z.string().describe('Tool name, as listed by figma_list_tools.'),
      args: z.record(z.unknown()).optional().describe("The tool's arguments."),
    },
  },
  // Passed through untouched: the result carries image blocks the model reads.
  async ({ tool, args }) =>
    (await post('/api/figma/call', { tool, args: (args ?? {}) as Json })) as {
      content: Array<{ type: 'text'; text: string }>
    },
)

const transport = new StdioServerTransport()
await server.connect(transport)
