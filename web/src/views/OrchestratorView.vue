<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import TerminalPanel from '../components/TerminalPanel.vue'
import { loadModels, modelLabel, modelOption, models } from '../models.js'
import { api } from '../api.js'
import { store, connect, mergeSessions } from '../store.js'

// When a toast is clicked, App passes the session id to open in the terminal.
const props = defineProps({ focusId: { type: String, default: null } })

const status = ref(null)
const error = ref(null)
const busy = ref(false)

// Which model profile backs the orchestrator (Setup → Models lists them).
// Seeded once from the persisted setting the daemon reports, then user-owned —
// picking here and hitting Start (or Restart, to hot-swap a live orchestrator)
// switches the model.
const agent = ref('claude')
let agentSeeded = false

// Project pin so the orchestrator starts with the right working context.
const projects = ref([])
const category = ref('')
const repo = ref('')

// A toast can point us at a session; we highlight and scroll its pane into view.
const focusedId = ref(null)
watch(
  () => props.focusId,
  (id) => {
    if (id) focusedId.value = id
  },
  { immediate: true },
)

let poll = null

const running = computed(() => status.value?.running === true)
const sessionId = computed(() => status.value?.id ?? null)
function awaitText(s) {
  return s?.awaitReason === 'idle' ? 'idle' : 'needs input'
}

const availableRepos = computed(() => {
  const cat = projects.value.find((p) => p.name === category.value)
  return cat?.repos ?? []
})
const pin = computed(() =>
  category.value && repo.value ? { category: category.value, repo: repo.value } : undefined,
)

// Per-pane draft text for the input box at the bottom of each agent window,
// keyed by session id. Sent to that session's PTY (with a submitting Enter) via
// the same input path the orchestrator uses to drive sub-agents.
const drafts = ref({})

const allSessions = computed(() => Object.values(store.sessions))
// One live terminal pane per agent, ordered: the orchestrator first, then the
// sub-agents it spawned, then any other live session (one-off commands, or
// agents orphaned by a prior orchestrator). Exited sessions drop out so the grid
// shows only what's actively working. Each pane owns its own socket + input
// (TerminalPanel), so every agent streams and is typed into independently.
const panes = computed(() => {
  const live = allSessions.value.filter((s) => !s.exited)
  const orch = live.filter((s) => s.id === sessionId.value)
  const subs = running.value
    ? live
        .filter((s) => s.parentId === sessionId.value && s.id !== sessionId.value)
        .sort((a, b) => a.startedAt - b.startedAt)
    : []
  const subIds = new Set(subs.map((s) => s.id))
  const others = live
    .filter((s) => s.kind !== 'orchestrator' && s.id !== sessionId.value && !subIds.has(s.id))
    .sort((a, b) => a.startedAt - b.startedAt)
  return [...orch, ...subs, ...others]
})

// ── Quick view: layout, order, and which agents are on screen ─────────────
// 'auto' is the free layout (panes wrap, each resizable); 1/2/3 are fixed
// 1×1 / 2×2 / 3×3 grids that fit the window. The chip strip picks which
// agents are shown and — by dragging, or the ◀ ▶ on each pane — their order.
// Remembered per browser.
const QV_KEY = 'flow-ui:quickview'
const LAYOUTS = [
  { id: 'auto', label: 'Auto', title: 'Free layout — panes wrap and resize' },
  { id: 1, label: '1×1', title: 'One agent, full size' },
  { id: 2, label: '2×2', title: 'Up to four agents' },
  { id: 3, label: '3×3', title: 'Up to nine agents' },
]
function readQv() {
  try {
    return JSON.parse(localStorage.getItem(QV_KEY) || '{}')
  } catch {
    return {}
  }
}
const qv = readQv()
const layout = ref(qv.layout ?? 'auto')
const order = ref(Array.isArray(qv.order) ? qv.order : [])
const hidden = ref(Array.isArray(qv.hidden) ? qv.hidden : [])
const expanded = ref(null)
watch([layout, order, hidden], () => {
  try {
    // Only keep ids that still exist, so the lists don't grow forever.
    const live = new Set(panes.value.map((p) => p.id))
    localStorage.setItem(
      QV_KEY,
      JSON.stringify({
        layout: layout.value,
        order: order.value.filter((id) => live.has(id)),
        hidden: hidden.value.filter((id) => live.has(id)),
      }),
    )
  } catch {
    /* private mode — preferences just don't persist */
  }
})

const ordered = computed(() => {
  const base = panes.value
  const rank = (p, i) => {
    const at = order.value.indexOf(p.id)
    return at === -1 ? 10_000 + i : at
  }
  return base
    .map((p, i) => ({ p, r: rank(p, i) }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.p)
})
const shown = computed(() => ordered.value.filter((p) => !hidden.value.includes(p.id)))
const capacity = computed(() => (layout.value === 'auto' ? Infinity : layout.value ** 2))
const gridPanes = computed(() => {
  if (expanded.value) return shown.value.filter((p) => p.id === expanded.value)
  return shown.value.slice(0, capacity.value)
})
// An expanded agent that exits drops back to the grid rather than an empty page.
watch(panes, (list) => {
  if (expanded.value && !list.some((p) => p.id === expanded.value)) expanded.value = null
})
// Rows actually used: two agents in a 2×2 get full-height halves, not quarters.
const gridRows = computed(() => {
  const n = expanded.value ? 1 : layout.value
  if (n === 'auto') return null
  return Math.max(1, Math.min(n, Math.ceil(gridPanes.value.length / n)))
})
const overflow = computed(() => Math.max(0, shown.value.length - capacity.value))
// A dragged pane size belongs to the layout it was made in; switching layout
// (or expanding a pane) drops it so every pane refills its new slot.
watch([layout, expanded], async () => {
  await nextTick()
  for (const el of document.querySelectorAll('.orchestrator__grid > .agent-pane')) {
    el.style.width = ''
    el.style.height = ''
  }
})

function toggleShown(id) {
  hidden.value = hidden.value.includes(id)
    ? hidden.value.filter((x) => x !== id)
    : [...hidden.value, id]
}
function setOrder(ids) {
  order.value = ids
}
function move(id, delta) {
  const ids = ordered.value.map((p) => p.id)
  const i = ids.indexOf(id)
  const j = i + delta
  if (i === -1 || j < 0 || j >= ids.length) return
  ;[ids[i], ids[j]] = [ids[j], ids[i]]
  setOrder(ids)
}
// Drag a chip onto another to put it in that place.
const dragId = ref(null)
function dropOn(targetId) {
  const from = dragId.value
  dragId.value = null
  if (!from || from === targetId) return
  const ids = ordered.value.map((p) => p.id).filter((x) => x !== from)
  ids.splice(ids.indexOf(targetId), 0, from)
  setOrder(ids)
}
function chipLabel(s) {
  if (s.kind === 'orchestrator') return 'orchestrator'
  return s.role || s.label.replace(/^agent\s+/, '')
}

function paneLabel(s) {
  if (s.kind === 'orchestrator') return '◆ orchestrator'
  return s.role ? `${s.role} · ${s.label}` : s.label
}

// Send the bottom-input draft to this agent's terminal (types the line + Enter).
async function sendInput(s) {
  const text = (drafts.value[s.id] ?? '').trim()
  if (!text) return
  try {
    await api.sessionInput(s.id, text)
    drafts.value[s.id] = ''
  } catch (e) {
    error.value = e.message
  }
}

// Scroll a toast-focused pane into view once it has rendered.
watch(focusedId, async (id) => {
  if (!id) return
  await nextTick()
  document.getElementById(`pane-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
})

async function refreshStatus() {
  try {
    status.value = await api.orchestrator.status()
    // Seed the picker from the daemon's remembered agent exactly once, so poll
    // ticks never clobber a pending choice the user hasn't started yet.
    if (!agentSeeded && status.value?.agent) {
      agent.value = status.value.agent
      agentSeeded = true
    }
  } catch (e) {
    error.value = e.message
  }
}

async function refreshSessions() {
  try {
    const { sessions: s } = await api.sessions()
    mergeSessions(s)
  } catch {
    // the agent tree is best-effort; ignore transient failures
  }
}

// Poll tick: keep the agent tree and the orchestrator status pill fresh (the
// status isn't pushed over the events socket, so without this it would only
// update on mount/exit). Skipped while an action is mid-flight to avoid
// clobbering the optimistic status returned by start/stop/restart.
async function tick() {
  if (busy.value) return
  await Promise.all([refreshSessions(), refreshStatus()])
}

// Re-pin the live orchestrator without restarting it (routes/orchestrator.ts).
async function repin() {
  busy.value = true
  error.value = null
  try {
    status.value = await api.orchestrator.pin(pin.value)
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

async function act(action) {
  busy.value = true
  error.value = null
  try {
    if (action === 'start') status.value = await api.orchestrator.start(pin.value, agent.value)
    else if (action === 'restart')
      status.value = await api.orchestrator.restart(pin.value, agent.value)
    else status.value = await api.orchestrator[action]()
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

// Stop a single pane: the orchestrator (full stop) or one sub-agent/session,
// leaving the rest running. The pane drops out of the grid once its exit lands
// on the events stream.
async function stopPane(s) {
  busy.value = true
  error.value = null
  try {
    if (s.kind === 'orchestrator') status.value = await api.orchestrator.stop()
    else await api.killSession(s.id)
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

function onExit() {
  refreshStatus()
}

onMounted(async () => {
  loadModels()
  await refreshStatus()
  await refreshSessions()
  // Share the app-wide events socket (App also calls this; connect() is a no-op
  // if already open). The socket is owned by the store and outlives this view.
  connect()
  try {
    const { projects: ps } = await api.projects()
    projects.value = ps
  } catch {
    // selector is optional; ignore
  }
  poll = setInterval(tick, 4000)
})

// --- Skills / standards in play for the pinned project ---------------------
const skills = ref(null)
const skillsOpen = ref(false)
const openSkill = ref(null)
// Full file text, fetched the first time a row is opened and kept thereafter.
// The list carries metadata only — shipping every body up front was ~81KB on a
// panel that starts collapsed. See routes/skills.ts.
const details = ref({})
const loadingDetail = ref(null)
// Which reference files are expanded, keyed `${skill}/${file}`.
const openRefs = ref({})

async function toggleRow(id, fetcher) {
  if (openSkill.value === id) {
    openSkill.value = null
    return
  }
  openSkill.value = id
  if (details.value[id]) return
  loadingDetail.value = id
  try {
    details.value = { ...details.value, [id]: await fetcher() }
  } catch (e) {
    details.value = { ...details.value, [id]: { error: e.message } }
  } finally {
    loadingDetail.value = null
  }
}
const toggleSkill = (name) => toggleRow(name, () => api.skillDetail(name))
const toggleStandard = (id) => toggleRow(id, () => api.standardDetail(id))
function toggleRef(skill, file) {
  const k = `${skill}/${file}`
  openRefs.value = { ...openRefs.value, [k]: !openRefs.value[k] }
}
const kb = (b) => (b < 1024 ? `${b}B` : `${(b / 1024).toFixed(1)}KB`)

async function loadSkills() {
  try {
    skills.value = await api.skills()
  } catch {
    skills.value = null
  }
}
// The pin only changes when the orchestrator (re)starts, so follow that — and
// mirror it into the pickers, so they show the live pin and Restart keeps it.
watch(
  () => [status.value?.category, status.value?.repo].join('/'),
  () => {
    loadSkills()
    if (status.value?.repo) {
      category.value = status.value.category
      repo.value = status.value.repo
    }
  },
  { immediate: true },
)
const pinnedText = computed(() =>
  status.value?.repo ? `${status.value.category}/${status.value.repo}` : null,
)
// A running orchestrator only picks up a new pin on Restart.
const pinPending = computed(
  () => running.value && !!pin.value && `${category.value}/${repo.value}` !== pinnedText.value,
)

onBeforeUnmount(() => {
  if (poll) clearInterval(poll)
})
</script>

<template>
  <section class="orchestrator">
    <header class="orchestrator__bar">
      <div class="orchestrator__id">
        <h2 class="view-title">Orchestrator</h2>
        <span class="pill orchestrator__status" :class="running ? 'ok' : 'bad'">
          {{ running ? 'running' : status?.exited ? `exited ${status.exitCode}` : 'stopped' }}
        </span>
        <span
          class="pill"
          :class="pinnedText ? 'ok' : 'bad'"
          :title="
            pinnedText
              ? 'Project the orchestrator is pinned to'
              : 'Pick a project and repo, then Start'
          "
        >
          📌 {{ pinnedText ?? 'no project pinned' }}
        </span>
        <button
          v-if="pinPending"
          class="btn primary"
          :disabled="busy"
          title="Move the pin now — the orchestrator keeps its conversation and is told about the new project. (Restart also re-pins, but starts a fresh conversation.)"
          @click="repin"
        >
          📌 Pin {{ category }}/{{ repo }}
        </button>
      </div>
      <div class="orchestrator__actions">
        <select
          v-model="agent"
          :disabled="busy"
          title="Model backing the orchestrator — applies on next Start (or Restart to hot-swap a running one). Add models in Setup → Models."
        >
          <option v-for="m in models" :key="m.id" :value="m.id">{{ modelOption(m) }}</option>
        </select>
        <select
          v-model="category"
          :disabled="busy"
          title="Project to pin — applies on Start, or Restart a running orchestrator"
          @change="repo = ''"
        >
          <option value="">— project —</option>
          <option
            v-for="p in projects"
            :key="p.slug"
            :value="p.name"
            :disabled="p.repos.length === 0"
          >
            {{ p.name }}
          </option>
        </select>
        <select
          v-model="repo"
          :disabled="busy || !category"
          title="Repo to pin — applies on Start, or Restart a running orchestrator"
        >
          <option value="">— repo —</option>
          <option v-for="r in availableRepos" :key="r" :value="r">{{ r }}</option>
        </select>
        <button class="btn primary" :disabled="busy || running" @click="act('start')">Start</button>
        <button class="btn" :disabled="busy || !running" @click="act('restart')">Restart</button>
      </div>
    </header>

    <section v-if="skills && (skills.skills.length || skills.standards.length)" class="skills-bar">
      <button class="skills-bar__toggle" @click="skillsOpen = !skillsOpen">
        <span class="skills-bar__chevron">{{ skillsOpen ? '▾' : '▸' }}</span>
        <span class="label">◇ IN PLAY</span>
        <span v-if="skills.repo" class="tag">{{ skills.category }}/{{ skills.repo }}</span>
        <span v-else class="tag faint">no project pinned</span>
        <span class="skills-bar__count">
          {{ skills.skills.filter((s) => s.matchesCategory).length }}/{{
            skills.skills.length
          }}
          skills<template v-if="skills.standards.length">
            · {{ skills.standards.length }} standard{{ skills.standards.length === 1 ? '' : 's' }}
          </template>
        </span>
      </button>

      <div v-show="skillsOpen" class="skills-bar__body">
        <p class="skills-bar__note">
          <strong>harness</strong> — served over MCP, so any engine gets them, but the agent must
          call <code>list_skills</code> / <code>read_skill</code> to load them.
          <strong>auto</strong> — picked up by claude's own discovery. <strong>injected</strong> —
          standards put into every agent prompt by Flow. The dot marks a skill named for this
          project; it is a hint, not a guarantee it fires.
        </p>

        <div
          v-for="sk in skills.skills"
          :key="sk.name"
          class="skill"
          :class="{ dim: !sk.matchesCategory }"
        >
          <button class="skill__head" @click="toggleSkill(sk.name)">
            <span class="skill__dot" :class="{ on: sk.matchesCategory }"></span>
            <code>{{ sk.name }}</code>
            <span class="skill__scope">{{ sk.category ?? 'cross-cutting' }}</span>
            <span class="skill__delivery" :class="sk.delivery">{{ sk.delivery }}</span>
            <span class="skill__refs">
              {{ kb(sk.bytes)
              }}<template v-if="sk.references.length">
                · {{ sk.references.length }} ref{{
                  sk.references.length === 1 ? '' : 's'
                }}</template
              >
            </span>
          </button>
          <div v-if="openSkill === sk.name" class="skill__detail">
            <p class="skill__desc">{{ sk.description }}</p>
            <p v-if="loadingDetail === sk.name" class="skill__loading">Reading SKILL.md…</p>
            <p v-else-if="details[sk.name]?.error" class="skill__loading">
              {{ details[sk.name].error }}
            </p>
            <template v-else-if="details[sk.name]">
              <div class="skill__file">
                <span class="skill__file-name">SKILL.md</span>
                <pre class="skill__body">{{ details[sk.name].body }}</pre>
              </div>
              <div v-for="r in details[sk.name].references" :key="r.file" class="skill__file">
                <button class="skill__file-toggle" @click="toggleRef(sk.name, r.file)">
                  <span>{{ openRefs[`${sk.name}/${r.file}`] ? '▾' : '▸' }}</span>
                  <span class="skill__file-name">references/{{ r.file }}</span>
                  <span class="skill__refs">{{ kb(r.body.length) }}</span>
                </button>
                <pre v-if="openRefs[`${sk.name}/${r.file}`]" class="skill__body">{{ r.body }}</pre>
              </div>
            </template>
          </div>
        </div>

        <div v-for="st in skills.standards" :key="st.id" class="skill standard">
          <button class="skill__head" @click="toggleStandard(st.id)">
            <span class="skill__dot on"></span>
            <code>{{ st.title }}</code>
            <span class="skill__scope">injected · {{ st.applies }}</span>
            <span class="skill__refs">{{ kb(st.bytes) }}</span>
          </button>
          <template v-if="openSkill === st.id">
            <p v-if="loadingDetail === st.id" class="skill__loading">Reading…</p>
            <p v-else-if="details[st.id]?.error" class="skill__loading">
              {{ details[st.id].error }}
            </p>
            <pre v-else-if="details[st.id]" class="skill__body">{{ details[st.id].body }}</pre>
          </template>
        </div>
      </div>
    </section>

    <div v-if="panes.length" class="quickview" role="toolbar" aria-label="Quick view">
      <div class="seg" role="group" aria-label="Layout">
        <button
          v-for="l in LAYOUTS"
          :key="l.id"
          class="btn"
          :class="{ primary: layout === l.id }"
          :title="l.title"
          :aria-pressed="layout === l.id"
          @click="((layout = l.id), (expanded = null))"
        >
          {{ l.label }}
        </button>
      </div>
      <div class="quickview__chips">
        <button
          v-for="p in ordered"
          :key="p.id"
          class="qv-chip"
          :class="{
            off: hidden.includes(p.id),
            waiting: p.awaitingInput,
            dragging: dragId === p.id,
          }"
          draggable="true"
          :aria-pressed="!hidden.includes(p.id)"
          :title="`${hidden.includes(p.id) ? 'Show' : 'Hide'} ${paneLabel(p)} — drag to reorder`"
          @click="toggleShown(p.id)"
          @dragstart="dragId = p.id"
          @dragend="dragId = null"
          @dragover.prevent
          @drop.prevent="dropOn(p.id)"
        >
          <span class="dot" :class="p.awaitingInput ? 'exited' : 'running'"></span>
          {{ chipLabel(p) }}
        </button>
      </div>
      <span v-if="overflow && !expanded" class="quickview__more"
        >+{{ overflow }} not shown — hide one or pick a bigger grid</span
      >
    </div>

    <div
      v-if="panes.length"
      class="orchestrator__grid"
      :class="expanded ? 'grid-n grid-1' : layout === 'auto' ? '' : `grid-n grid-${layout}`"
      :style="gridRows ? { '--rows': gridRows } : undefined"
    >
      <div
        v-for="s in gridPanes"
        :id="`pane-${s.id}`"
        :key="s.id"
        class="agent-pane"
        :class="{ focused: s.id === focusedId, 'agent-pane--sub': s.kind === 'subagent' }"
      >
        <div class="agent-pane__head">
          <span class="dot" :class="s.exited ? 'exited' : 'running'"></span>
          <span v-if="s.role" class="agent-role">{{ s.role }}</span>
          <span class="agent-pane__label">{{ paneLabel(s) }}</span>
          <span
            v-if="s.awaitingInput"
            class="needs-input"
            :class="{ idle: s.awaitReason === 'idle' }"
            >{{ awaitText(s) }}</span
          >
          <span class="agent-pane__tools">
            <button
              class="btn subtle icon"
              title="Move earlier"
              aria-label="Move earlier"
              @click="move(s.id, -1)"
            >
              ◀
            </button>
            <button
              class="btn subtle icon"
              title="Move later"
              aria-label="Move later"
              @click="move(s.id, 1)"
            >
              ▶
            </button>
            <button
              class="btn subtle icon"
              :title="expanded === s.id ? 'Back to the grid' : 'Quick view — this agent full size'"
              :aria-label="expanded === s.id ? 'Collapse' : 'Expand'"
              @click="expanded = expanded === s.id ? null : s.id"
            >
              {{ expanded === s.id ? '⤡' : '⤢' }}
            </button>
          </span>
          <button
            class="btn subtle danger agent-pane__stop"
            :disabled="busy"
            :title="s.kind === 'orchestrator' ? 'Stop the orchestrator' : 'Stop this sub-agent'"
            @click="stopPane(s)"
          >
            Stop
          </button>
        </div>
        <div class="agent-pane__term">
          <TerminalPanel :session-id="s.id" @exit="onExit" />
        </div>
        <form class="agent-pane__input" @submit.prevent="sendInput(s)">
          <input
            v-model="drafts[s.id]"
            type="text"
            :placeholder="`Message ${s.role || 'this agent'}…`"
            autocomplete="off"
            spellcheck="false"
          />
          <button class="btn primary" type="submit" :disabled="!(drafts[s.id] || '').trim()">
            Send
          </button>
        </form>
      </div>
    </div>
    <div v-else class="orchestrator__empty">
      Pick a project (optional) and Start the orchestrator to drive the workspace through
      {{ modelLabel(agent) }}.
    </div>

    <div v-if="error" class="form-error">{{ error }}</div>
  </section>
</template>
