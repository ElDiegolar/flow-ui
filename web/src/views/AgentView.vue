<script setup>
import { computed, onMounted, ref } from 'vue'
import { api } from '../api.js'
import { loadModels, modelOption, models } from '../models.js'
import CommandsPanel from '../components/CommandsPanel.vue'

const emit = defineEmits(['session-start'])

const projects = ref([])
const agent = ref(null) // model profile id; seeded from Setup's sub-agent default
const category = ref('')
const repo = ref('')
const prompt = ref('')
const error = ref(null)

onMounted(async () => {
  loadModels().then((s) => (agent.value ??= s?.subagentDefault ?? 'codex'))
  try {
    const { projects: ps } = await api.projects()
    projects.value = ps
  } catch (e) {
    error.value = e.message
  }
})

const availableRepos = computed(() => {
  const cat = projects.value.find((p) => p.name === category.value)
  return cat?.repos ?? []
})

async function run() {
  try {
    const body = {
      command: 'agent',
      profile: agent.value ?? undefined,
    }
    if (category.value && repo.value) {
      body.category = category.value
      body.repo = repo.value
    }
    if (prompt.value.trim()) body.prompt = prompt.value
    const res = await api.startSession(body)
    emit('session-start', { id: res.id, label: res.label })
  } catch (e) {
    error.value = e.message
  }
}
</script>

<template>
  <section class="form-pane">
    <h2>Run agent</h2>
    <p class="hint">
      Spawns a coding agent on the model you pick (add models in Setup → Models) in a PTY. You can
      type interactively into the xterm panel on the right after the session starts.
    </p>

    <div class="form-row">
      <label>Model</label>
      <select v-model="agent">
        <option v-for="m in models" :key="m.id" :value="m.id">{{ modelOption(m) }}</option>
      </select>
    </div>

    <div class="form-row">
      <label>Project (optional)</label>
      <select v-model="category">
        <option value="">— workspace root —</option>
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

    <CommandsPanel
      :category="category"
      :repo="repo"
      @session-start="emit('session-start', $event)"
    />

    <div class="form-row">
      <label>Initial prompt (optional)</label>
      <textarea
        v-model="prompt"
        rows="4"
        placeholder="e.g. find every component using LegacyModal and migrate to the new one"
      ></textarea>
    </div>

    <div class="form-actions">
      <button class="btn primary" :disabled="category && !repo" @click="run">Start session</button>
    </div>

    <div v-if="error" class="form-error">{{ error }}</div>
  </section>
</template>
