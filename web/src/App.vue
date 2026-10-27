<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import TasksView from './views/TasksView.vue'
import OrchestratorView from './views/OrchestratorView.vue'
import AgentView from './views/AgentView.vue'
import CommitView from './views/CommitView.vue'
import DiffView from './views/DiffView.vue'
import SettingsView from './views/SettingsView.vue'
import CommandRunner from './components/CommandRunner.vue'
import SetupIntro from './components/SetupIntro.vue'
import { api } from './api.js'
import {
  store,
  applyTabSettings,
  connect,
  contextLabel,
  loadIntegrations,
  loadSync,
  refreshSync,
} from './store.js'

// Tabs whose one-off sessions stream into the shared CommandRunner below them.
const RUNNER_TABS = ['agent', 'commit', 'settings']

const health = ref(null)
const view = ref('tasks')
const activeSession = ref(null)
// Session a toast points at — handed to the orchestrator so its terminal opens
// on that agent when we switch to the Orchestrator tab.
const focusId = ref(null)

// Header pills for the MCP integrations. Hidden when switched off in Setup.
function integrationWord(st) {
  if (!st || st.state === 'disabled') return null
  if (st.state === 'connected') return 'connected'
  if (st.state === 'connecting') return 'connecting…'
  return 'off'
}
function integrationClass(st) {
  if (st?.state === 'connected') return 'ok'
  if (st?.state === 'connecting') return 'info'
  return 'bad'
}
let syncPoll = null

const tabs = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'orchestrator', label: 'Orchestrator' },
  { id: 'agent', label: 'Agent', optional: true },
  { id: 'commit', label: 'Commit', optional: true },
  { id: 'diff', label: 'Diff', optional: true },
  { id: 'settings', label: 'Setup' },
]

// A hidden optional tab leaves the strip, but stays visible while it is the
// current view, so a navigation to it (toast, "Open Setup", TasksView) never
// lands on nothing. It drops out when the developer leaves it.
const visibleTabs = computed(() =>
  tabs.filter((t) => !t.optional || store.tabs[t.id] || view.value === t.id),
)
// Turning the tab you are on off sends you back to the core flow.
watch(
  () => ({ ...store.tabs }),
  (on) => {
    const current = tabs.find((t) => t.id === view.value)
    if (current?.optional && !on[current.id]) view.value = 'tasks'
  },
)

const handleSessionStart = ({ id, label }) => {
  activeSession.value = { id, label }
}
// The first-run intro starts AI Setup: close it, mark it done, and show the
// stream on the Setup page where the run's progress is visible.
async function introSessionStart(s) {
  handleSessionStart(s)
  showIntro.value = false
  view.value = 'settings'
  try {
    await api.settings.update({ onboardedAt: Date.now() })
  } catch {
    /* worst case the intro shows again next load */
  }
}
const handleSessionClear = () => {
  activeSession.value = null
}
// TasksView asks to jump to another tab (e.g. 'orchestrator') after starting work.
const handleNavigate = (target) => {
  if (tabs.some((t) => t.id === target)) view.value = target
}

// On a phone the tab strip scrolls sideways — keep the active tab in view.
const tabsEl = ref(null)
watch(view, async () => {
  await Promise.resolve()
  tabsEl.value
    ?.querySelector('.tab.active')
    ?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
})

// --- First-run intro (MCP setup) ------------------------------------------
const showIntro = ref(false)
async function loadOnboarding() {
  try {
    const s = await api.settings.get()
    applyTabSettings(s)
    showIntro.value = s.onboardedAt == null
  } catch {
    /* no settings → don't block the app on an intro */
  }
}
// Re-read the header's workspace name after AI Setup changed it.
async function reloadHealth() {
  try {
    health.value = await api.health()
    store.health = health.value
  } catch {
    /* keep the last good header */
  }
}
async function rerunSetup() {
  try {
    await api.settings.update({ onboardedAt: null })
  } catch {
    /* show it anyway */
  }
  showIntro.value = true
}
function introDone() {
  showIntro.value = false
  loadSetup()
}

// --- Theme ------------------------------------------------------------------
// auto (follow the OS) | light | dark — the default corporate theme — or the
// original neon look, kept as an opt-in 'cyberpunk' theme.
const THEME_KEY = 'flow-ui:theme'
const THEMES = [
  { id: 'auto', label: 'Auto' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'cyberpunk', label: 'Cyberpunk' },
]
const theme = ref('auto')
function loadCyberpunkFonts() {
  if (document.getElementById('cyberpunk-fonts')) return
  const link = document.createElement('link')
  link.id = 'cyberpunk-fonts'
  link.rel = 'stylesheet'
  link.href =
    'https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Rajdhani:wght@500;600;700&family=Share+Tech+Mono&display=swap'
  document.head.appendChild(link)
}
function applyTheme(t) {
  if (!THEMES.some((x) => x.id === t)) t = 'auto'
  theme.value = t
  if (t === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
  if (t === 'cyberpunk') loadCyberpunkFonts()
  try {
    localStorage.setItem(THEME_KEY, t)
  } catch {
    /* private mode — still applies for this page */
  }
}
try {
  applyTheme(localStorage.getItem(THEME_KEY) || 'auto')
} catch {
  applyTheme('auto')
}

// The active context (repo @ branch) in the header — every tab follows it.
const ctxText = computed(() => contextLabel())

// --- Toasts (+ desktop notifications) when an agent needs the developer ---
// Sourced from the store's single session feed (one /api/events socket).
const toasts = ref([])
const awaiting = new Set()

const awaitTitle = (session) =>
  session.awaitReason === 'idle' ? 'Agent idle' : 'Agent needs your input'

function pushToast(session) {
  const idle = session.awaitReason === 'idle'
  toasts.value.push({ id: session.id, label: session.label || 'agent', title: awaitTitle(session) })
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      new Notification(`Flow — ${awaitTitle(session).toLowerCase()}`, {
        body: `${session.label || 'An agent'} ${idle ? 'has gone idle' : 'is waiting for you'}.`,
        tag: `await-${session.id}`,
      })
    } catch {
      /* ignore */
    }
  }
}
function dismissToast(id) {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

/**
 * Toasts fire on the EDGE into "awaiting", not on every event while awaiting.
 *
 * `store.sessions` is replaced wholesale on each socket message, so the watch
 * below re-runs this for every session on every event. Pushing whenever
 * `awaitingInput` was true meant a dismissed toast came straight back on the
 * next event — with a second desktop notification each time. `awaiting` is the
 * memory of "we already told the developer about this one": while the id is in
 * it we only refresh an on-screen toast's wording, never re-notify and never
 * resurrect one the developer dismissed. It clears when the agent genuinely
 * stops waiting, so the next real transition notifies again.
 */
function handleSessionState(s) {
  if (!s || s.exited) {
    if (s) {
      awaiting.delete(s.id)
      dismissToast(s.id)
    }
    return
  }
  if (s.awaitingInput) {
    if (!awaiting.has(s.id)) {
      awaiting.add(s.id)
      pushToast(s)
      return
    }
    // Already announced — only keep the wording current (prompt → idle).
    const existing = toasts.value.find((t) => t.id === s.id)
    if (existing) existing.title = awaitTitle(s)
  } else if (awaiting.has(s.id)) {
    awaiting.delete(s.id)
    dismissToast(s.id)
  }
}

// Clicking a toast switches to the Orchestrator tab and focuses that session's
// terminal there (the orchestrator owns the live agent terminals).
function goToSession(id) {
  focusId.value = id
  view.value = 'orchestrator'
  dismissToast(id)
}

// Re-evaluate toast state whenever the session map changes (replaced wholesale
// per event, so a shallow watch fires).
watch(
  () => store.sessions,
  (map) => {
    for (const s of Object.values(map)) handleSessionState(s)
  },
)

onMounted(async () => {
  try {
    health.value = await api.health()
    store.health = health.value
  } catch (e) {
    console.error(e)
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {})
  }
  connect()
  loadSync()
  loadSetup()
  loadIntegrations()
  loadOnboarding()
  // Cheap local-ref read; the daemon refreshes remotes on its own slow timer.
  syncPoll = setInterval(loadSync, 60_000)
})

onBeforeUnmount(() => {
  if (syncPoll) clearInterval(syncPoll)
})

// --- Repos behind origin ----------------------------------------------------
// Every repo whose remote has commits we lack is named in the banner: the agents
// work on the local checkout, so a stale one gives them an outdated view.
const behindRepos = computed(() => (store.sync?.projects ?? []).filter((p) => p.outOfDate))
const behindNames = computed(() => behindRepos.value.map((p) => p.name).join(', '))
const syncAgeLabel = computed(() => {
  const at = store.sync?.fetchedAt
  if (!at) return 'never checked'
  const mins = Math.round((Date.now() - at) / 60000)
  if (mins < 1) return 'checked just now'
  if (mins < 60) return `checked ${mins}m ago`
  return `checked ${Math.round(mins / 60)}h ago`
})
// First-run: if nothing is authenticated (or no workspace exists yet), say so
// before the developer starts a task and watches an agent die on launch.
const setup = ref(null)
const needsSetup = computed(() => setup.value && !setup.value.ready)
async function loadSetup() {
  try {
    setup.value = await api.setup.get()
  } catch {
    /* leave it null — the Setup tab reports properly */
  }
}

const checking = ref(false)
async function checkSync() {
  checking.value = true
  try {
    await refreshSync()
  } finally {
    checking.value = false
  }
}
</script>

<template>
  <div class="app">
    <header class="app__header">
      <div class="app__title">
        <span class="app__brand"><span class="app__logo" aria-hidden="true"></span>Flow</span>
        <nav ref="tabsEl" class="tabs" aria-label="Sections">
          <button
            v-for="t in visibleTabs"
            :key="t.id"
            class="tab"
            :class="{ active: view === t.id }"
            :aria-current="view === t.id ? 'page' : undefined"
            @click="view = t.id"
          >
            {{ t.label }}
          </button>
        </nav>
      </div>
      <div class="app__meta">
        <span
          class="pill app__context"
          :class="{ faint: !ctxText }"
          :title="ctxText ? 'Active context — Diff follows it' : 'No project pinned'"
          >{{ ctxText ?? 'no project pinned' }}</span
        >
        <span
          v-if="health"
          class="pill app__workspace"
          :class="health.workspace ? '' : 'bad'"
          :title="health.workspace ?? 'No workspace yet — open Setup'"
          >{{ health.workspaceName ?? 'no workspace' }}</span
        >
        <button
          v-if="integrationWord(store.integrations?.atlassian)"
          type="button"
          class="pill"
          :class="integrationClass(store.integrations?.atlassian)"
          :aria-label="`Jira ${integrationWord(store.integrations?.atlassian)}`"
          :title="`Jira: ${integrationWord(store.integrations?.atlassian)} — open Setup`"
          @click="view = 'settings'"
        >
          jira{{ store.integrations?.atlassian?.state === 'connecting' ? '…' : '' }}
        </button>
        <button
          v-if="integrationWord(store.integrations?.figma)"
          type="button"
          class="pill"
          :class="integrationClass(store.integrations?.figma)"
          :aria-label="`Figma ${integrationWord(store.integrations?.figma)}`"
          :title="`Figma Desktop: ${integrationWord(store.integrations?.figma)} — open Setup`"
          @click="view = 'settings'"
        >
          figma{{ store.integrations?.figma?.state === 'connecting' ? '…' : '' }}
        </button>
        <select
          class="theme-select"
          :value="theme"
          aria-label="Theme"
          title="Theme"
          @change="applyTheme($event.target.value)"
        >
          <option v-for="t in THEMES" :key="t.id" :value="t.id">{{ t.label }}</option>
        </select>
      </div>
    </header>

    <div class="app__body">
      <div v-if="needsSetup" class="desync desync--setup">
        <span class="desync__icon">⚙</span>
        <div class="desync__body">
          <strong>Setup incomplete — agents will fail to start</strong>
          <span class="desync__detail">
            {{
              setup.unconfigured
                ? 'Nothing is authenticated yet.'
                : 'A required agent is not logged in.'
            }}
            Open Setup for the checks and the commands that fix them.
          </span>
        </div>
        <button class="btn" @click="view = 'settings'">Open Setup</button>
      </div>

      <div v-if="behindRepos.length" class="desync">
        <span class="desync__icon">⚠</span>
        <div class="desync__body">
          <strong>
            {{ behindRepos.length }} repo{{ behindRepos.length === 1 ? '' : 's' }} behind origin
          </strong>
          <span class="desync__detail">
            {{ behindNames }} · pull before the agents work on them · {{ syncAgeLabel }}
          </span>
        </div>
        <button class="btn" :disabled="checking" @click="checkSync">
          {{ checking ? 'Checking…' : 'Check now' }}
        </button>
      </div>

      <!-- Kept alive, not re-created per tab switch: the orchestrator's live
           terminals, pane sizes, quick-view layout and drafts — and the Diff
           selection — survive leaving the tab and coming back. -->
      <KeepAlive :include="['TasksView', 'OrchestratorView', 'DiffView']">
        <TasksView v-if="view === 'tasks'" @navigate="handleNavigate" />
        <OrchestratorView v-else-if="view === 'orchestrator'" :focus-id="focusId" />
        <DiffView v-else-if="view === 'diff'" />
      </KeepAlive>
      <SettingsView
        v-if="view === 'settings'"
        @rerun-setup="rerunSetup"
        @session-start="handleSessionStart"
        @workspace-changed="reloadHealth"
      />
      <template v-else-if="view === 'agent' || view === 'commit'">
        <AgentView v-if="view === 'agent'" @session-start="handleSessionStart" />
        <CommitView v-else @session-start="handleSessionStart" />
      </template>

      <CommandRunner
        v-if="RUNNER_TABS.includes(view)"
        :session="activeSession"
        @clear="handleSessionClear"
      />
    </div>

    <SetupIntro v-if="showIntro" @done="introDone" @session-start="introSessionStart" />

    <div v-if="toasts.length" class="toasts">
      <div v-for="t in toasts" :key="t.id" class="toast">
        <span class="toast__icon">⚠</span>
        <div class="toast__body">
          <strong>{{ t.title }}</strong>
          <span class="toast__label">{{ t.label }}</span>
        </div>
        <button class="btn primary" @click="goToSession(t.id)">Open</button>
        <button class="toast__x" title="dismiss" @click="dismissToast(t.id)">✕</button>
      </div>
    </div>
  </div>
</template>
