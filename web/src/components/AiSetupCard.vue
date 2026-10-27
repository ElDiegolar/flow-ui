<script setup>
/**
 * AI Setup: the body of the Setup → Workspace card (and the first-run intro's
 * first step). One button starts a Claude session that links the developer's
 * repos into a workspace and writes its config, AGENTS.md and standards. The
 * session itself streams in the host page's CommandRunner: this card only
 * emits session-start, then watches the session and re-reads the project list
 * when it exits, so the new categories show without a reload.
 */
import { computed, ref, watch } from 'vue'
import { api, errorText } from '../api.js'
import { store } from '../store.js'

const DEFAULT_PATH = '~/code'

const props = defineProps({
  ready: { type: Boolean, required: true },
  reason: { type: String, default: '' },
})
const emit = defineEmits(['session-start', 'session-done'])

const scanPath = ref(DEFAULT_PATH)
const busy = ref(false)
const error = ref(null)
const run = ref(null) // { id, label } of the setup session this card started
const discovered = ref(null) // [{ name, repos: [{ name }] }] after the run
const reading = ref(false)

const exited = computed(() => (run.value ? store.sessions[run.value.id]?.exited === true : false))

watch(exited, (done) => {
  if (done) void afterRun()
})

async function start() {
  if (!props.ready || busy.value) return
  busy.value = true
  error.value = null
  discovered.value = null
  try {
    const started = await api.setup.ai(scanPath.value.trim() || DEFAULT_PATH)
    run.value = started
    emit('session-start', { id: started.id, label: started.label })
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}

// The agent reloads the config itself; doing it again here is a safe net for a
// run that stopped early. Then read the categories the run left behind.
async function afterRun() {
  reading.value = true
  try {
    await api.config.reload()
    const res = await api.projects()
    discovered.value = Array.isArray(res) ? res : (res?.projects ?? [])
  } catch (e) {
    error.value = errorText(e)
  } finally {
    reading.value = false
    emit('session-done', { id: run.value?.id ?? null })
  }
}

const repoCount = computed(() =>
  (discovered.value ?? []).reduce((n, c) => n + (c.repos?.length ?? 0), 0),
)
</script>

<template>
  <div class="ai-setup">
    <div class="settings-inline">
      <label for="ai-setup-path"><strong>Code folder</strong></label>
      <input
        id="ai-setup-path"
        v-model="scanPath"
        type="text"
        spellcheck="false"
        placeholder="~/code"
        :disabled="busy"
        class="ai-setup__path"
        @keydown.enter="start"
      />
      <button
        class="btn primary"
        :disabled="!ready || busy"
        :title="!ready ? reason : ''"
        @click="start"
      >
        {{ busy ? 'Starting…' : 'AI Setup' }}
      </button>
    </div>

    <p v-if="!ready && reason" class="check__detail">{{ reason }}</p>
    <p class="check__detail">
      Creates symlinks under the workspace's projects folder, writes AGENTS.md and standards, builds
      code graphs. Your repos stay where they are, and git sees no change in them. The first time
      Claude opens a folder it asks you to trust it: answer in the pane below.
    </p>

    <p v-if="error" class="settings-view__error">{{ error }}</p>

    <div v-if="run && !exited" class="check__detail">Setup is running in the output below.</div>

    <div v-if="reading" class="check__detail">Reading the workspace…</div>
    <div v-else-if="discovered" class="ai-setup__found">
      <div class="check__detail">
        Found {{ discovered.length }} {{ discovered.length === 1 ? 'category' : 'categories' }},
        {{ repoCount }} {{ repoCount === 1 ? 'repo' : 'repos' }}.
      </div>
      <ul>
        <li v-for="c in discovered" :key="c.slug ?? c.name">
          <strong>{{ c.name }}</strong>
          <span class="check__detail">
            {{ (c.repos ?? []).map((r) => r.name).join(', ') || 'no repos' }}
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.ai-setup__path {
  min-width: 14rem;
  flex: 1 1 14rem;
  padding: var(--sp-075) var(--sp-100);
  background: var(--input-bg);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font: 400 var(--fs-sm) / 1.4 var(--font-mono);
}
.ai-setup__path:focus {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: inset 0 0 0 1px var(--border-focus);
}
.ai-setup__found ul {
  margin: var(--sp-100) 0 0;
  padding-left: 1.2rem;
  font-size: var(--fs-sm);
}
.ai-setup__found li + li {
  margin-top: var(--sp-050);
}
</style>
