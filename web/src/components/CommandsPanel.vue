<script setup>
/**
 * The team's own scripts (flow.config.json `commands`), as buttons for the
 * current repo or the workspace. Running one starts a PTY session; the host
 * page streams it in its CommandRunner. A destructive command (confirm: true)
 * asks first, and only then is sent with confirmed: true, which the daemon
 * requires for it.
 */
import { ref, watch } from 'vue'
import { api, errorText } from '../api.js'

const props = defineProps({
  category: { type: String, default: '' },
  repo: { type: String, default: '' },
})
const emit = defineEmits(['session-start'])

const commands = ref([])
const error = ref(null)
const busy = ref(null) // id of the command being started

async function load() {
  error.value = null
  try {
    const res = await api.commands.list(props.category, props.repo)
    commands.value = res.commands ?? []
  } catch (e) {
    commands.value = []
    error.value = errorText(e)
  }
}

watch(() => [props.category, props.repo], load, { immediate: true })

async function run(cmd) {
  if (busy.value) return
  if (cmd.confirm && !window.confirm(`Run "${cmd.label}"? This is marked as destructive.`)) return
  busy.value = cmd.id
  error.value = null
  try {
    const body = { command: 'run', id: cmd.id }
    if (cmd.scope === 'repo') {
      body.category = props.category
      body.repo = props.repo
    }
    if (cmd.confirm) body.confirmed = true
    const res = await api.startSession(body)
    emit('session-start', { id: res.id, label: res.label })
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div class="form-row commands-panel">
    <label>Commands</label>
    <div class="commands-panel__list">
      <button
        v-for="cmd in commands"
        :key="cmd.id"
        class="btn"
        :class="{ danger: cmd.confirm }"
        :disabled="busy !== null"
        :title="`${cmd.scope === 'workspace' ? 'Runs at the workspace root' : 'Runs in the repo'}${cmd.confirm ? ' · asks first' : ''}`"
        @click="run(cmd)"
      >
        {{ cmd.label }}
      </button>
      <span v-if="!commands.length && !error" class="hint">
        No commands for this scope. Add a <code>commands</code> array to flow.config.json (see
        examples/).
      </span>
    </div>
    <div v-if="error" class="form-error">{{ error }}</div>
  </div>
</template>

<style scoped>
.commands-panel__list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-075);
  align-items: center;
}
</style>
