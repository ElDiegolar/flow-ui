/**
 * App-wide reactive store — the single source of truth for the live session
 * feed. ONE /api/events socket fills `sessions`, and every view reads from it
 * (App's agent-await toasts + the orchestrator's agent tree) instead of opening
 * its own socket. Also caches the health snapshot.
 */
import { reactive } from 'vue'
import { api, streamEvents } from './api.js'

// Optional tabs the developer can switch off in Setup (daemon settings.tabs).
// Tasks, Orchestrator and Setup are not here — they are the core flow.
const TAB_DEFAULTS = { agent: true, commit: true, diff: true }

export const store = reactive({
  // Live SessionSummary map keyed by id.
  sessions: {},
  health: null,
  // Which optional tabs show in the strip (see applyTabSettings).
  tabs: { ...TAB_DEFAULTS },
  // Git sync report: { projects[], fetchedAt, refreshing } or null.
  sync: null,
  // The active context — pinned repo + its live branch (daemon context.ts).
  // Diff follows it; pushed over the events socket as it moves.
  context: null,
  // Daemon-held MCP connections: { atlassian, figma } status, or null.
  integrations: null,
  // Bumped when the daemon says the board changed, so views can watch a
  // number instead of polling.
  tasksVersion: 0,
})

/** Read sync state (local refs only — no network). Safe to poll. */
export async function loadSync() {
  try {
    store.sync = await api.sync.get()
  } catch {
    /* leave the last good report up rather than blanking the indicators */
  }
}

/** Fetch every remote, then re-read. Costs network — user-initiated only. */
export async function refreshSync() {
  try {
    store.sync = await api.sync.refresh()
  } catch {
    /* keep the stale report; the banner shows how old it is */
  }
}

/** Sync entry for one repo, or null if we have no report yet. */
export function repoSync(category, repo) {
  return store.sync?.projects?.find((p) => p.category === category && p.repo === repo) ?? null
}

function upsert(s) {
  store.sessions = { ...store.sessions, [s.id]: { ...store.sessions[s.id], ...s } }
}

// Merge sessions from a REST poll (the fallback when the events socket drops)
// into the live map without clobbering fields the socket already set.
export function mergeSessions(list) {
  for (const s of list) upsert(s)
}

let ws = null
export function connect() {
  if (ws) return
  try {
    ws = streamEvents()
    ws.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.type === 'snapshot') {
        const map = {}
        for (const s of msg.sessions) map[s.id] = s
        store.sessions = map
      } else if (msg.type === 'context') {
        store.context = msg.context
      } else if (msg.type === 'tasks-changed') {
        store.tasksVersion++
      } else if (msg.type === 'integrations') {
        // The event is a nudge; the REST read carries the Jira-access detail.
        loadIntegrations()
      } else if (msg.session) {
        upsert(msg.session)
      }
    })
    ws.addEventListener('close', () => {
      if (ws) ws = null
      // Reconnect: the context/board events only arrive over this socket, so a
      // dropped one would silently freeze every tab that follows them.
      setTimeout(connect, 3000)
    })
  } catch {
    /* views still work off their REST poll fallback */
  }
}

/** Label for the active context, e.g. "web/app @ feature/x". */
export function contextLabel(ctx = store.context) {
  if (!ctx?.repo) return null
  return `${ctx.category}/${ctx.repo}${ctx.branch ? ` @ ${ctx.branch}` : ''}`
}

/** Copy the daemon's tab toggles into the store; missing keys fall back to on. */
export function applyTabSettings(settings) {
  const t = settings?.tabs ?? {}
  for (const id of Object.keys(TAB_DEFAULTS)) {
    store.tabs[id] = typeof t[id] === 'boolean' ? t[id] : TAB_DEFAULTS[id]
  }
}

export async function loadIntegrations() {
  try {
    store.integrations = await api.integrations.get()
  } catch {
    /* Setup shows the error */
  }
}

/**
 * Whether the claude CLI is installed and logged in, from a /api/setup report.
 * AI Setup runs on claude, so its button is gated on this and the reason shows
 * under the disabled button.
 */
export function claudeReadiness(setup) {
  const claude = setup?.checks?.find((c) => c.id === 'claude')
  if (!setup) return { ready: false, reason: 'Checking the Claude Code CLI…' }
  if (!claude) return { ready: false, reason: 'Claude Code is not set up yet — see Setup.' }
  return {
    ready: claude.status === 'ready',
    reason: claude.status === 'ready' ? '' : (claude.detail ?? 'Claude Code is not ready'),
  }
}
