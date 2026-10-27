<script setup>
/**
 * Commit: stage everything in one repo and commit it with the message the
 * developer wrote here. No agent is involved — the daemon runs plain git in the
 * repo, and the output streams in the shared CommandRunner.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { api, errorText } from '../api.js'
import { store } from '../store.js'

const emit = defineEmits(['session-start'])

const projects = ref([])
const category = ref('')
const repo = ref('')
const message = ref('')
const status = ref(null)
const busy = ref(false)
const error = ref(null)

const availableRepos = computed(() => {
  const cat = projects.value.find((p) => p.name === category.value)
  return cat?.repos ?? []
})
const canCommit = computed(
  () => !!category.value && !!repo.value && message.value.trim() !== '' && !busy.value,
)

// Changed-file count for the picked repo, so the developer sees what the commit
// will carry before pressing the button.
async function loadStatus() {
  status.value = null
  if (!category.value || !repo.value) return
  try {
    status.value = await api.git.status(category.value, repo.value, 'head')
  } catch (e) {
    error.value = errorText(e)
  }
}

function onCategoryChange() {
  repo.value = ''
  status.value = null
}
watch(repo, loadStatus)

onMounted(async () => {
  try {
    const { projects: ps } = await api.projects()
    projects.value = ps
  } catch (e) {
    error.value = errorText(e)
  }
  // Start on the repo the developer is working in, if there is one.
  const ctx = store.context
  if (ctx?.category && ctx?.repo) {
    category.value = ctx.category
    repo.value = ctx.repo
  }
})

async function run() {
  busy.value = true
  error.value = null
  try {
    const res = await api.startSession({
      command: 'git-commit',
      category: category.value,
      repo: repo.value,
      message: message.value.trim(),
    })
    emit('session-start', { id: res.id, label: res.label })
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="form-pane">
    <h2>Commit</h2>
    <p class="hint">
      Stages every change in the repo (<code>git add -A</code>) and commits it with your message.
      Nothing is pushed. Run <strong>Diff</strong> first to review what will go in.
    </p>

    <div class="form-row">
      <label>Project</label>
      <select v-model="category" @change="onCategoryChange">
        <option value="">— pick a project —</option>
        <option
          v-for="p in projects"
          :key="p.slug"
          :value="p.name"
          :disabled="p.repos.length === 0"
        >
          {{ p.name }} ({{ p.repos.length }} repos)
        </option>
      </select>
    </div>

    <div class="form-row" v-if="category">
      <label>Repository</label>
      <select v-model="repo">
        <option value="">— pick a repo —</option>
        <option v-for="r in availableRepos" :key="r" :value="r">{{ r }}</option>
      </select>
    </div>

    <p v-if="status" class="hint">
      {{ status.branch }} · {{ status.files?.length ?? 0 }} changed
      {{ (status.files?.length ?? 0) === 1 ? 'file' : 'files' }}
    </p>

    <div class="form-row">
      <label>Commit message</label>
      <textarea
        v-model="message"
        rows="4"
        placeholder="e.g. Fix the empty state on the orders list"
      ></textarea>
    </div>

    <div class="form-actions">
      <button class="btn primary" :disabled="!canCommit" @click="run">
        {{ busy ? 'Committing…' : 'Commit' }}
      </button>
    </div>

    <div v-if="error" class="form-error">{{ error }}</div>
  </section>
</template>
