<script setup>
import { computed, onActivated, onMounted, ref, watch } from 'vue'
import { api, errorText } from '../api.js'
import { store } from '../store.js'

const emit = defineEmits(['navigate'])

const tasks = ref([])
const projects = ref([])
const error = ref(null)
const busy = ref(false)

// Create form
const title = ref('')
const description = ref('')
const jiraUrl = ref('')
const category = ref('')
const repo = ref('')

// 'parked' is a real status the daemon sets (on a task switch, and on shutdown
// for anything resumable). Without it here the status <select> renders blank
// for a parked task and there is no way to move it back.
const STATUSES = ['todo', 'in_progress', 'parked', 'review', 'done']

// ── Jira ────────────────────────────────────────────────────────────────────
// The daemon discovers boards and syncs the selected one itself, over its one
// Atlassian connection (no orchestrator round-trip): open issues become tasks,
// and anything done or gone in Jira is cleared from this list — parked or not.
const jiraReadOnly = ref(true)
const jiraBusy = ref(null) // 'discover' | 'sync' | null
const jira = ref({ boards: [], selectedId: null, lastSync: null })
const selectedBoard = computed(
  () => jira.value.boards.find((b) => b.id === jira.value.selectedId) || null,
)
const jiraConnected = computed(() => store.integrations?.atlassian?.state === 'connected')

async function loadJira() {
  try {
    jira.value = await api.jira.get()
  } catch {
    // best-effort
  }
}

async function onSelectBoard(e) {
  try {
    jira.value = { ...jira.value, ...(await api.jira.selectBoard(e.target.value || null)) }
  } catch (err) {
    error.value = errorText(err)
  }
}

async function jiraAction(kind) {
  jiraBusy.value = kind
  error.value = null
  try {
    if (kind === 'discover') jira.value = { ...jira.value, ...(await api.jira.discover()) }
    else jira.value = (await api.jira.sync()).jira
    await refresh()
  } catch (e) {
    error.value = errorText(e)
    await loadJira()
  } finally {
    jiraBusy.value = null
  }
}

async function toggleJiraReadOnly() {
  try {
    const s = await api.settings.update({ jiraReadOnly: !jiraReadOnly.value })
    jiraReadOnly.value = s.jiraReadOnly
  } catch (e) {
    error.value = errorText(e)
  }
}

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000)
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`
}
const syncLine = computed(() => {
  const l = jira.value.lastSync
  if (!l) return null
  if (!l.ok) return { bad: true, text: `Sync failed ${ago(l.at)} — ${l.error}` }
  const bits = [`${l.open} open`]
  if (l.created) bits.push(`${l.created} new`)
  if (l.cleared) bits.push(`${l.cleared} cleared`)
  if (l.flagged) bits.push(`${l.flagged} done but still running`)
  return { bad: false, text: `Synced ${ago(l.at)} · ${bits.join(' · ')}` }
})

// ── The list: the selected board's open issues + your local tasks ─────────
const showCleared = ref(false)
const onSelected = (t) => {
  const b = selectedBoard.value
  if (!b) return true
  return t.boardId ? t.boardId === b.id : !!t.jiraKey?.startsWith(`${b.key}-`)
}
const visible = computed(() =>
  tasks.value.filter((t) =>
    t.archivedAt ? showCleared.value : t.source !== 'jira' || onSelected(t),
  ),
)
const hiddenOtherBoards = computed(
  () => tasks.value.filter((t) => !t.archivedAt && t.source === 'jira' && !onSelected(t)).length,
)

const availableRepos = computed(() => {
  const cat = projects.value.find((p) => p.name === category.value)
  return cat?.repos ?? []
})
const canCreate = computed(() => title.value.trim() || jiraUrl.value.trim())

async function refresh() {
  try {
    const { tasks: t } = await api.tasks.list(showCleared.value)
    tasks.value = t
  } catch (e) {
    error.value = errorText(e)
  }
}
watch(showCleared, refresh)

// The daemon pushes 'tasks-changed' after every sync (timer, board pick, agent).
watch(
  () => store.tasksVersion,
  () => {
    refresh()
    loadJira()
  },
)

async function create() {
  busy.value = true
  error.value = null
  try {
    await api.tasks.create({
      title: title.value,
      description: description.value,
      jiraUrl: jiraUrl.value,
      category: category.value,
      repo: repo.value,
    })
    title.value = ''
    description.value = ''
    jiraUrl.value = ''
    category.value = ''
    repo.value = ''
    await refresh()
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}

// Start work is two steps: confirm (or pick) the task's project, then start.
// Starting pinned means the orchestrator gets the ticket brief AND the project
// together — pinning afterwards meant a restart that threw the brief away.
const pinFor = ref(null) // task id whose project step is open
const pinCat = ref('')
const pinRepo = ref('')
const pinRepos = computed(() => projects.value.find((p) => p.name === pinCat.value)?.repos ?? [])

async function openPinStep(t) {
  error.value = null
  let cat = t.category ?? ''
  let rep = t.repo ?? ''
  if (!cat || !rep) {
    // No project on the task yet: suggest whatever is pinned right now.
    try {
      const ctx = await api.context()
      cat = ctx?.category ?? ''
      rep = ctx?.repo ?? ''
    } catch {
      /* no suggestion */
    }
  }
  pinCat.value = cat
  pinRepo.value = rep
  pinFor.value = t.id
}

async function startWork(t) {
  if (!pinCat.value || !pinRepo.value) return
  busy.value = true
  error.value = null
  try {
    if (t.category !== pinCat.value || t.repo !== pinRepo.value)
      await api.tasks.update(t.id, { category: pinCat.value, repo: pinRepo.value })
    await api.tasks.start(t.id)
    pinFor.value = null
    await refresh()
    // Jump to the Orchestrator tab to watch the agents work.
    emit('navigate', 'orchestrator')
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}

async function setStatus(t, status) {
  try {
    await api.tasks.update(t.id, { status })
    await refresh()
  } catch (e) {
    error.value = errorText(e)
  }
}

async function remove(t) {
  try {
    await api.tasks.remove(t.id)
    await refresh()
  } catch (e) {
    error.value = errorText(e)
  }
}

onMounted(async () => {
  await refresh()
  try {
    const { projects: ps } = await api.projects()
    projects.value = ps
  } catch {
    // selector optional
  }
  try {
    const s = await api.settings.get()
    jiraReadOnly.value = s.jiraReadOnly
  } catch {
    // settings optional
  }
  await loadJira()
})

// Kept alive across tab switches (App.vue) — catch up on return.
onActivated(() => {
  refresh()
  loadJira()
})
</script>

<template>
  <section class="tasks">
    <div class="form-pane">
      <div class="jira-bar">
        <span class="jira-bar__label">Jira board</span>
        <select
          v-if="jira.boards.length"
          :value="jira.selectedId ?? ''"
          class="jira-board-select"
          title="The board this list shows"
          @change="onSelectBoard"
        >
          <option value="">— all boards —</option>
          <option v-for="b in jira.boards" :key="b.id" :value="b.id">
            {{ b.name }}{{ b.site ? ` · ${b.site}` : ''
            }}{{ b.issueCount != null ? ` (${b.issueCount})` : '' }}
          </option>
        </select>
        <button
          class="btn"
          :disabled="!!jiraBusy || !jiraConnected"
          title="Find the boards you have assigned work in"
          @click="jiraAction('discover')"
        >
          {{
            jiraBusy === 'discover' ? 'Looking…' : jira.boards.length ? 'Rediscover' : 'Find boards'
          }}
        </button>
        <button
          class="btn primary"
          :disabled="!!jiraBusy || !jiraConnected || !selectedBoard"
          title="Pull the board now (it also syncs by itself)"
          @click="jiraAction('sync')"
        >
          {{ jiraBusy === 'sync' ? 'Syncing…' : 'Sync now' }}
        </button>
        <label
          class="jira-toggle"
          :class="{ on: jiraReadOnly }"
          title="Refuse any agent call that would change Jira"
        >
          <input type="checkbox" :checked="jiraReadOnly" @change="toggleJiraReadOnly" />
          read-only
        </label>
      </div>
      <p v-if="!jiraConnected" class="hint">
        Jira isn't connected — connect it once in
        <a href="#" @click.prevent="emit('navigate', 'settings')">Setup</a>
        and this list follows your board by itself.
      </p>
      <p v-else-if="syncLine" class="hint" :class="{ 'hint--bad': syncLine.bad }">
        {{ syncLine.text }}
      </p>

      <h2>New task</h2>
      <p class="hint">
        Type a task or paste a Jira link (the link + your description are stored — no Jira
        credentials needed). Pin a project so <strong>Start work</strong> hands the orchestrator the
        right context; it then delegates the work to a sub-agent.
      </p>

      <div class="form-row">
        <label>Title</label>
        <input
          v-model="title"
          placeholder="What needs doing?"
          @keyup.enter="canCreate && create()"
        />
      </div>
      <div class="form-row">
        <label>Jira link</label>
        <input v-model="jiraUrl" placeholder="https://…/browse/ABC-123 (optional)" />
      </div>
      <div class="form-row">
        <label>Details</label>
        <textarea
          v-model="description"
          rows="3"
          placeholder="Context, acceptance criteria…"
        ></textarea>
      </div>
      <div class="form-row proj">
        <label>Project</label>
        <select v-model="category">
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
        <select v-model="repo" :disabled="!category">
          <option value="">— repo —</option>
          <option v-for="r in availableRepos" :key="r" :value="r">{{ r }}</option>
        </select>
      </div>
      <div class="form-actions">
        <button class="btn primary" :disabled="busy || !canCreate" @click="create">Add task</button>
      </div>
      <div v-if="error" class="form-error">{{ error }}</div>
    </div>

    <div class="task-list">
      <div class="task-list__bar">
        <span class="task-list__count"
          >{{ visible.filter((t) => !t.archivedAt).length }} task{{
            visible.filter((t) => !t.archivedAt).length === 1 ? '' : 's'
          }}<template v-if="selectedBoard"> on {{ selectedBoard.key }}</template></span
        >
        <span v-if="hiddenOtherBoards" class="task-list__hidden"
          >{{ hiddenOtherBoards }} on other boards hidden</span
        >
        <label class="jira-toggle">
          <input v-model="showCleared" type="checkbox" />
          show cleared
        </label>
      </div>
      <article
        v-for="t in visible"
        :key="t.id"
        class="task-card"
        :class="[`status-${t.status}`, { 'task-card--cleared': t.archivedAt }]"
      >
        <header class="task-card__head">
          <span class="pill" :class="`st-${t.status}`">{{ t.status.replace('_', ' ') }}</span>
          <h3 class="task-card__title">{{ t.title }}</h3>
        </header>
        <p v-if="t.jiraGone" class="task-card__flag">
          Done or removed in Jira — it's cleared from this list once its agents stop.
        </p>
        <p v-if="t.archivedAt" class="task-card__flag faint">
          Cleared {{ ago(t.archivedAt) }} — {{ t.archivedReason }}
        </p>
        <div class="task-card__meta">
          <span v-if="t.category && t.repo" class="tag">{{ t.category }}/{{ t.repo }}</span>
          <a v-if="t.jiraUrl" :href="t.jiraUrl" target="_blank" rel="noopener" class="tag jira">
            {{ t.jiraKey ?? 'Jira' }}
          </a>
          <span v-if="t.jiraStatus" class="tag">{{ t.jiraStatus }}</span>
          <span v-if="t.sessionIds?.length" class="tag faint"
            >{{ t.sessionIds.length }} session(s)</span
          >
        </div>
        <p v-if="t.description" class="task-card__desc">{{ t.description }}</p>
        <form
          v-if="pinFor === t.id"
          class="task-card__pin"
          aria-label="Project for this task"
          @submit.prevent="startWork(t)"
        >
          <span class="task-card__pin-label">📌 Project for this task</span>
          <select v-model="pinCat" aria-label="Project" @change="pinRepo = ''">
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
          <select v-model="pinRepo" aria-label="Repo" :disabled="!pinCat">
            <option value="">— repo —</option>
            <option v-for="r in pinRepos" :key="r" :value="r">{{ r }}</option>
          </select>
          <button class="btn primary" type="submit" :disabled="busy || !pinCat || !pinRepo">
            {{ busy ? 'Starting…' : 'Pin & start' }}
          </button>
          <button class="btn" type="button" :disabled="busy" @click="pinFor = null">Cancel</button>
        </form>
        <div class="task-card__actions">
          <button
            v-if="pinFor !== t.id"
            class="btn primary"
            :disabled="busy"
            @click="openPinStep(t)"
          >
            Start work
          </button>
          <a v-if="t.jiraUrl" class="btn jira-link" :href="t.jiraUrl" target="_blank" rel="noopener"
            >{{ t.jiraKey ? `View ${t.jiraKey} on Jira` : 'View on Jira' }} ↗</a
          >
          <select :value="t.status" @change="setStatus(t, $event.target.value)">
            <option v-for="s in STATUSES" :key="s" :value="s">{{ s.replace('_', ' ') }}</option>
          </select>
          <button class="btn subtle danger" :disabled="busy" @click="remove(t)">Delete</button>
        </div>
      </article>
      <div v-if="visible.length === 0" class="task-empty">
        {{
          selectedBoard
            ? `Nothing open for you on ${selectedBoard.key} — or add a local task.`
            : 'No tasks yet — connect Jira, or add one to kick off the dev team.'
        }}
      </div>
    </div>
  </section>
</template>
