<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { api, errorText } from '../api.js'
import { store } from '../store.js'

const projects = ref([])
const category = ref('')
const repo = ref('')
const status = ref(null)
const selected = ref(null)
const diff = ref('')
const error = ref(null)
const loading = ref(false)

const availableRepos = computed(() => {
  const cat = projects.value.find((p) => p.name === category.value)
  return cat?.repos ?? []
})
const canLoad = computed(() => category.value && repo.value)

// What the changes are measured against. 'head' is uncommitted work only;
// 'staging' is everything this branch carries that the deployed branch does
// not — committed work included, which is the review question.
const base = ref('staging')

// Follow the active context (the orchestrator's pinned repo + its branch):
// when it moves — a new task, a branch switch — the pickers move with it and
// the changes reload. Picking a different repo by hand stops following until
// "Follow" is pressed again, so a manual look is never yanked away.
const following = ref(true)
const ctxKey = computed(() => store.context?.key ?? null)

function followContext() {
  const ctx = store.context
  if (!ctx?.repo) return
  following.value = true
  category.value = ctx.category
  repo.value = ctx.repo
  loadStatus()
}

watch(ctxKey, () => {
  if (following.value) followContext()
})

// Changing the project clears the repo + any loaded diff status.
function onCategoryChange() {
  following.value = false
  repo.value = ''
  status.value = null
}
function onRepoChange() {
  following.value = false
  if (canLoad.value) loadStatus()
}

// The file list and every diff are relative to the base, so switching it
// invalidates both rather than silently mixing the two.
function onBaseChange() {
  selected.value = null
  diff.value = ''
  if (canLoad.value) loadStatus()
}

// Split a unified diff into classified lines for coloring.
const diffLines = computed(() =>
  diff.value.split('\n').map((text) => {
    let cls = 'ctx'
    if (text.startsWith('+++') || text.startsWith('---')) cls = 'meta'
    else if (text.startsWith('@@')) cls = 'hunk'
    else if (text.startsWith('diff ') || text.startsWith('index ')) cls = 'meta'
    else if (text.startsWith('+')) cls = 'add'
    else if (text.startsWith('-')) cls = 'del'
    return { text, cls }
  }),
)

function shortStatus(s) {
  const m = s.trim()
  if (s === '??') return 'new'
  if (m.includes('D')) return 'del'
  if (m.includes('A')) return 'add'
  if (m.includes('R')) return 'ren'
  return 'mod'
}

async function loadStatus() {
  if (!canLoad.value) return
  error.value = null
  selected.value = null
  diff.value = ''
  loading.value = true
  try {
    status.value = await api.git.status(category.value, repo.value, base.value)
  } catch (e) {
    error.value = errorText(e)
    status.value = null
  } finally {
    loading.value = false
  }
}

async function selectFile(f) {
  selected.value = f.path
  error.value = null
  diff.value = ''
  try {
    const r = await api.git.diff(category.value, repo.value, f.path, base.value)
    diff.value = r.diff || '(no diff content)'
  } catch (e) {
    error.value = errorText(e)
  }
}

onMounted(async () => {
  try {
    const { projects: ps } = await api.projects()
    projects.value = ps
  } catch {
    // selector optional
  }
  followContext()
})
</script>

<template>
  <section class="diff">
    <header class="diff__bar">
      <select v-model="category" @change="onCategoryChange">
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
      <select v-model="repo" :disabled="!category" @change="onRepoChange">
        <option value="">— repo —</option>
        <option v-for="r in availableRepos" :key="r" :value="r">{{ r }}</option>
      </select>
      <select v-model="base" title="What the changes are measured against" @change="onBaseChange">
        <option value="staging">vs staging</option>
        <option value="head">uncommitted only</option>
      </select>
      <button class="btn primary" :disabled="!canLoad || loading" @click="loadStatus">
        {{ loading ? 'Loading…' : 'Reload' }}
      </button>
      <button
        v-if="store.context?.repo"
        class="btn"
        :class="following ? 'subtle' : ''"
        :disabled="following"
        :title="
          following
            ? 'Following the active context — switches with the orchestrator'
            : 'Jump back to the active context and keep following it'
        "
        @click="followContext"
      >
        {{ following ? '● Following context' : 'Follow context' }}
      </button>
      <span v-if="status" class="pill">
        {{ status.branch }} · {{ status.files.length }} changed
      </span>
      <span v-if="status?.baseRef" class="pill" :class="{ bad: status.behind > 0 }">
        vs {{ status.baseRef
        }}<template v-if="status.behind != null"> · {{ status.behind }} behind</template>
      </span>
      <span v-if="status?.baseError" class="pill bad">{{ status.baseError }}</span>
    </header>

    <div v-if="error" class="form-error">{{ error }}</div>

    <div class="diff__main" v-if="status">
      <aside class="diff__files">
        <button
          v-for="f in status.files"
          :key="f.path"
          class="diff-file"
          :class="{ selected: selected === f.path }"
          @click="selectFile(f)"
        >
          <span class="diff-file__badge" :class="shortStatus(f.status)">{{
            shortStatus(f.status)
          }}</span>
          <span class="diff-file__path">{{ f.path }}</span>
        </button>
        <div v-if="status.clean" class="diff__empty">Working tree clean — no changes.</div>
      </aside>

      <div class="diff__view">
        <pre v-if="selected" class="diff-pre"><code><span
          v-for="(l, i) in diffLines"
          :key="i"
          class="diff-line"
          :class="l.cls"
        >{{ l.text }}</span></code></pre>
        <div v-else class="diff__empty">Select a file to view its diff.</div>
      </div>
    </div>
    <div v-else-if="!error" class="diff__empty">
      {{
        store.context?.repo
          ? 'Loading the active context…'
          : 'No project pinned — pick a project + repo to review what the agents did.'
      }}
    </div>
  </section>
</template>
