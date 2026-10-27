const TOKEN_KEY = 'flow-ui:token'

let token = sessionStorage.getItem(TOKEN_KEY) || null

export function getToken() {
  return token
}

export async function bootstrapToken() {
  // 1. Token from URL query string — strip it after capture so it doesn't linger in history.
  const url = new URL(window.location.href)
  const fromQuery = url.searchParams.get('token')
  if (fromQuery) {
    const res = await fetch(`/api/auth/bootstrap?token=${encodeURIComponent(fromQuery)}`)
    const data = await res.json()
    if (data.authenticated) {
      token = data.token
      sessionStorage.setItem(TOKEN_KEY, token)
      url.searchParams.delete('token')
      window.history.replaceState({}, '', url.toString())
      return
    }
  }
  // 2. Already-stored token from a previous reload.
  if (token) return
  // 3. No token. Surface an error so the UI can render an instruction.
  console.warn('flow: no token; open the URL printed by the daemon')
}

/**
 * The human part of an API error: authedFetch throws "<path> -> <status>:
 * <body>", and the body is usually { error }. Views show this, not the URL.
 */
export function errorText(e) {
  const msg = e?.message ?? String(e)
  const m = msg.match(/-> \d+: ([\s\S]*)$/)
  if (!m) return msg
  try {
    return JSON.parse(m[1]).error ?? m[1]
  } catch {
    return m[1]
  }
}

async function authedFetch(path, init = {}) {
  const headers = new Headers(init.headers || {})
  if (token) headers.set('X-Flow-Token', token)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${path} -> ${res.status}: ${body}`)
  }
  return res.json()
}

export const api = {
  health: () => fetch('/api/health').then((r) => r.json()),
  projects: () => authedFetch('/api/projects'),
  sessions: () => authedFetch('/api/sessions'),
  // Store a pasted image; returns { path } to type into the terminal.
  pasteImage: (data, type) =>
    authedFetch('/api/paste', { method: 'POST', body: JSON.stringify({ data, type }) }),
  startSession: (body) =>
    authedFetch('/api/sessions', { method: 'POST', body: JSON.stringify(body) }),
  killSession: (id) => authedFetch(`/api/sessions/${id}`, { method: 'DELETE' }),
  // Type into a running session's PTY (manual UI / debugging; the orchestrator
  // drives sub-agents server-side via the send_input MCP tool).
  sessionInput: (id, text, opts = {}) =>
    authedFetch(`/api/sessions/${id}/input`, {
      method: 'POST',
      body: JSON.stringify({ text, ...opts }),
    }),
  orchestrator: {
    status: () => authedFetch('/api/orchestrator'),
    // pin: optional { category, repo } to give the orchestrator project context.
    // agent: optional 'claude' | 'codex'; omitted → reuse the last-used agent.
    start: (pin, agent) =>
      authedFetch('/api/orchestrator', {
        method: 'POST',
        body: JSON.stringify({ action: 'start', ...(pin ?? {}), ...(agent ? { agent } : {}) }),
      }),
    stop: () =>
      authedFetch('/api/orchestrator', {
        method: 'POST',
        body: JSON.stringify({ action: 'stop' }),
      }),
    restart: (pin, agent) =>
      authedFetch('/api/orchestrator', {
        method: 'POST',
        body: JSON.stringify({ action: 'restart', ...(pin ?? {}), ...(agent ? { agent } : {}) }),
      }),
    // Move the pin on a live orchestrator without restarting it (keeps its conversation).
    pin: (pin) =>
      authedFetch('/api/orchestrator/pin', { method: 'POST', body: JSON.stringify(pin) }),
    prompt: (text) =>
      authedFetch('/api/orchestrator/prompt', {
        method: 'POST',
        body: JSON.stringify({ text }),
      }),
  },
  tasks: {
    // archived: include tasks the board sync cleared (done / gone in Jira).
    list: (archived = false) => authedFetch(`/api/tasks${archived ? '?archived=1' : ''}`),
    create: (body) => authedFetch('/api/tasks', { method: 'POST', body: JSON.stringify(body) }),
    update: (id, patch) =>
      authedFetch(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (id) => authedFetch(`/api/tasks/${id}`, { method: 'DELETE' }),
    // Hand the task to the orchestrator (pins project + seeds the brief).
    start: (id) => authedFetch(`/api/tasks/${id}/start`, { method: 'POST' }),
    // Park: snapshot the task's terminal history to disk + stop its processes.
    park: (id) => authedFetch(`/api/tasks/${id}/park`, { method: 'POST' }),
    // Resume: re-spawn the agents; returns { sessions:[{oldId,newId,...}], pin }.
    resume: (id) => authedFetch(`/api/tasks/${id}/resume`, { method: 'POST' }),
    // The parked manifest (agent roster + pin) for a parked task.
    parked: (id) => authedFetch(`/api/tasks/${id}/parked`),
    // Saved scrollback for a resumed session (by its NEW id) — for terminal replay.
    history: (id, sessionId) => authedFetch(`/api/tasks/${id}/sessions/${sessionId}/history`),
  },
  jira: {
    get: () => authedFetch('/api/jira'),
    selectBoard: (id) =>
      authedFetch('/api/jira/select', { method: 'PUT', body: JSON.stringify({ id }) }),
    // Run by the daemon over its own Atlassian connection — no orchestrator needed.
    discover: () => authedFetch('/api/jira/discover', { method: 'POST' }),
    sync: () => authedFetch('/api/jira/sync', { method: 'POST' }),
  },
  // The daemon's single connection per external MCP server (atlassian | figma).
  integrations: {
    get: () => authedFetch('/api/integrations'),
    // action: 'connect' | 'disconnect' | 'reset'
    act: (name, action) => authedFetch(`/api/integrations/${name}/${action}`, { method: 'POST' }),
  },
  // The active context: pinned repo + its live branch. Also pushed over /api/events.
  context: () => authedFetch('/api/context'),
  // First-run readiness: which agents / MCP servers / workspace are configured.
  setup: {
    get: () => authedFetch('/api/setup'),
    // Start the AI Setup session → { id, label } to stream in a CommandRunner.
    ai: (scanPath, workspace) =>
      authedFetch('/api/setup/ai', {
        method: 'POST',
        body: JSON.stringify({ scanPath, workspace }),
      }),
  },
  // Re-read flow.config.json and the workspace after the AI Setup wrote files.
  config: { reload: () => authedFetch('/api/config/reload', { method: 'POST' }) },
  // What skills/standards are in play for a project (defaults to the pin).
  skills: (category, repo) => {
    const q =
      category && repo
        ? `?category=${encodeURIComponent(category)}&repo=${encodeURIComponent(repo)}`
        : ''
    return authedFetch(`/api/skills${q}`)
  },
  // Full text of one skill (SKILL.md + its references), fetched on expand.
  skillDetail: (name) => authedFetch(`/api/skills/${encodeURIComponent(name)}`),
  // The team's configured commands for a repo or the workspace (flow.config.json).
  commands: {
    list: (category, repo) => {
      const q = new URLSearchParams()
      if (category) q.set('category', category)
      if (repo) q.set('repo', repo)
      const qs = q.toString()
      return authedFetch(`/api/commands${qs ? `?${qs}` : ''}`)
    },
  },
  // Full text of one mirrored standard.
  standardDetail: (id) => authedFetch(`/api/skills/standard/${encodeURIComponent(id)}`),
  sync: {
    // Cheap read of local refs — safe to poll. Reflects the last refresh.
    get: () => authedFetch('/api/sync'),
    // Costs network (fetches every repo); only call on an explicit user action.
    refresh: () => authedFetch('/api/sync/refresh', { method: 'POST' }),
  },
  settings: {
    get: () => authedFetch('/api/settings'),
    update: (patch) => authedFetch('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
    // Check a (possibly unsaved) model profile's endpoint → { ok, detail, models? }.
    testModel: (profile) =>
      authedFetch('/api/models/test', { method: 'POST', body: JSON.stringify(profile) }),
  },
  git: {
    // base: 'head' (uncommitted only) or 'staging' (everything the deployed
    // branch doesn't have, committed work included).
    status: (category, repo, base = 'head') =>
      authedFetch(
        `/api/git/status?category=${encodeURIComponent(category)}&repo=${encodeURIComponent(
          repo,
        )}&base=${encodeURIComponent(base)}`,
      ),
    // Switch a repo's branch; the active context (and every tab) follows.
    branch: (body) =>
      authedFetch('/api/git/branch', { method: 'POST', body: JSON.stringify(body) }),
    diff: (category, repo, file, base = 'head') =>
      authedFetch(
        `/api/git/diff?category=${encodeURIComponent(category)}&repo=${encodeURIComponent(
          repo,
        )}&file=${encodeURIComponent(file)}&base=${encodeURIComponent(base)}`,
      ),
  },
}

export function streamSession(id) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${proto}//${window.location.host}/api/sessions/${id}/stream?token=${encodeURIComponent(token)}`
  return new WebSocket(url)
}

// Global session-lifecycle feed: a snapshot frame then session-created/updated/
// exited events, so the UI can show subagents spinning up live.
export function streamEvents() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${proto}//${window.location.host}/api/events?token=${encodeURIComponent(token)}`
  return new WebSocket(url)
}
