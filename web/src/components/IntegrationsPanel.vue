<script setup>
/**
 * The daemon's MCP connections (Atlassian, Figma): live state, Connect /
 * Disconnect / Reset, and the endpoint config. Shared by the Setup tab and the
 * first-run intro, so both drive the same single connection per server.
 *
 * Connect is the ONLY path that may open an Atlassian sign-in window, and it
 * only happens when someone presses it here.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api, errorText } from '../api.js'
import { loadIntegrations, store } from '../store.js'

const props = defineProps({
  // Which servers to show; both by default.
  only: { type: Array, default: () => ['atlassian', 'figma'] },
  // Hide the endpoint/advanced config (the intro keeps it simple).
  compact: { type: Boolean, default: false },
})
const emit = defineEmits(['changed'])

const META = {
  atlassian: {
    title: 'Atlassian (Jira)',
    blurb:
      'Syncs your Jira board into Tasks and lets agents read issues. One sign-in, shared by ' +
      'every agent — held by Flow, not by each agent.',
  },
  figma: {
    title: 'Figma Desktop',
    blurb:
      'Lets the orchestrator read the designs a task links to, or the frame you have selected. ' +
      'Nothing to sign in to: open the Figma Desktop app and enable its local MCP server ' +
      '(Preferences). Connect also sets up the folder its design assets are saved to.',
  },
}

const STATE_LABEL = {
  connected: 'Connected',
  connecting: 'Connecting…',
  'needs-auth': 'Not signed in',
  idle: 'Not connected',
  error: 'Error',
  disabled: 'Off',
}

const settings = ref(null)
const busy = ref({})
const error = ref(null)
const confirmReset = ref(null)
let poll = null

const servers = computed(() =>
  props.only.map((name) => ({ name, ...META[name], st: store.integrations?.[name] ?? null })),
)
const anyConnecting = computed(() => servers.value.some((s) => s.st?.state === 'connecting'))

// Connected but consented without Jira: technically up, practically useless.
const noJira = (s) =>
  s.name === 'atlassian' && s.st?.state === 'connected' && s.st.jiraAccess?.sites === 0
function tone(state, s) {
  if (s && noJira(s)) return 'warn'
  if (state === 'connected') return 'ok'
  if (state === 'connecting') return 'info'
  if (state === 'disabled') return 'neutral'
  return 'warn'
}

async function act(name, action) {
  busy.value = { ...busy.value, [name]: action }
  error.value = null
  confirmReset.value = null
  try {
    await api.integrations.act(name, action)
    await loadIntegrations()
    emit('changed')
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = { ...busy.value, [name]: null }
  }
}

// Figma's allowed-directories list is Figma's own setting: we only show the
// exact folder to add and re-check, never edit it.
const copied = ref(false)
async function copyPath(p) {
  try {
    await navigator.clipboard.writeText(p)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    /* clipboard blocked — the path is on screen to select */
  }
}
const rechecking = ref(false)
async function recheck() {
  rechecking.value = true
  try {
    await loadIntegrations()
  } finally {
    rechecking.value = false
  }
}

async function save(patch) {
  error.value = null
  try {
    settings.value = await api.settings.update(patch)
    await loadIntegrations()
    emit('changed')
  } catch (e) {
    error.value = errorText(e)
  }
}

// While a connect is in flight (a human may be in a browser window), follow it.
watch(
  anyConnecting,
  (on) => {
    if (on && !poll) poll = setInterval(loadIntegrations, 1500)
    if (!on && poll) {
      clearInterval(poll)
      poll = null
      emit('changed')
    }
  },
  { immediate: true },
)

onMounted(async () => {
  await loadIntegrations()
  try {
    settings.value = await api.settings.get()
  } catch {
    /* config fields just stay hidden */
  }
})
onBeforeUnmount(() => poll && clearInterval(poll))
</script>

<template>
  <div class="integrations">
    <article v-for="s in servers" :key="s.name" class="integration">
      <header class="integration__head">
        <div class="integration__title">
          <h4>{{ s.title }}</h4>
          <span class="lozenge" :class="tone(s.st?.state, s)">{{
            noJira(s) ? 'Connected · no Jira access' : (STATE_LABEL[s.st?.state] ?? '…')
          }}</span>
        </div>
        <div class="integration__actions">
          <button
            v-if="s.st?.state !== 'connected'"
            class="btn primary"
            :disabled="!!busy[s.name] || s.st?.state === 'connecting' || s.st?.state === 'disabled'"
            @click="act(s.name, 'connect')"
          >
            {{ s.st?.state === 'connecting' ? 'Connecting…' : 'Connect' }}
          </button>
          <button
            v-else
            class="btn subtle"
            :disabled="!!busy[s.name]"
            @click="act(s.name, 'disconnect')"
          >
            Disconnect
          </button>
          <button
            v-if="s.name === 'atlassian'"
            class="btn subtle danger"
            :disabled="!!busy[s.name] || s.st?.state === 'connecting'"
            title="Forget the cached sign-in so the next Connect starts fresh"
            @click="confirmReset = confirmReset === s.name ? null : s.name"
          >
            Reset
          </button>
        </div>
      </header>

      <p class="integration__blurb">{{ s.blurb }}</p>
      <p v-if="s.st" class="integration__detail">{{ s.st.detail }}</p>

      <template v-if="s.name === 'figma' && s.st?.assets?.dir && s.st.state !== 'disabled'">
        <p v-if="s.st.assets.allowed" class="integration__detail">
          ✓ Design assets save to <code>{{ s.st.assets.dir }}</code> — Figma is allowed to write
          there.
        </p>
        <div
          v-else
          class="integration__hint"
          :class="{ 'integration__hint--warn': s.st.assets.allowed === false }"
        >
          <p>
            {{
              s.st.assets.allowed === false
                ? 'Figma is not allowed to save design assets yet, so it refuses to hand over a frame’s spacing, radii and shadows.'
                : 'Could not read Figma’s settings to check whether it may save design assets.'
            }}
            Add this folder once:
          </p>
          <p class="integration__path">
            <code>{{ s.st.assets.figmaPath }}</code>
            <button class="btn subtle" @click="copyPath(s.st.assets.figmaPath)">
              {{ copied ? 'Copied' : 'Copy' }}
            </button>
          </p>
          <ol>
            <li>In Figma Desktop, open a design file and switch to <strong>Dev Mode</strong>.</li>
            <li>
              Open the <strong>MCP</strong> panel → <strong>Allowed directories</strong> → add the
              folder above.
            </li>
            <li>Come back and press <strong>Re-check</strong>.</li>
          </ol>
          <button class="btn subtle" :disabled="rechecking" @click="recheck">
            {{ rechecking ? 'Checking…' : 'Re-check' }}
          </button>
        </div>
      </template>

      <p v-if="s.st?.state === 'connecting' && s.name === 'atlassian'" class="integration__hint">
        Finish signing in in the browser window that opened. On the consent screen, make sure your
        <strong>Jira</strong> site is ticked — a Confluence-only grant cannot read your board.
        <a v-if="s.st.authUrl" :href="s.st.authUrl" target="_blank" rel="noopener"
          >Didn't see a window? Open the sign-in page ↗</a
        >
      </p>
      <p v-else-if="noJira(s)" class="integration__hint integration__hint--warn">
        This sign-in was granted without Jira (only
        {{ s.st.jiraAccess.withoutJira.join(', ') || 'no sites' }}), so the board can't be read.
        Press <strong>Reset</strong>, then <strong>Connect</strong>, and tick your Jira site on the
        Atlassian consent screen.
      </p>
      <p
        v-else-if="s.name === 'atlassian' && s.st?.state === 'needs-auth'"
        class="integration__hint"
      >
        Press <strong>Connect</strong> to sign in once. After that Flow reconnects on its own with
        the saved login — restarting agents never asks again.
      </p>

      <div v-if="confirmReset === s.name" class="integration__confirm">
        <span
          >Disconnect and set the saved sign-in aside? You'll sign in again on the next Connect. (It
          is moved, not deleted.)</span
        >
        <button class="btn danger" @click="act(s.name, 'reset')">Reset</button>
        <button class="btn subtle" @click="confirmReset = null">Cancel</button>
      </div>

      <details v-if="!compact && settings" class="integration__config">
        <summary>Configuration</summary>
        <label class="settings-toggle">
          <input
            type="checkbox"
            :checked="settings[s.name].enabled"
            @change="save({ [s.name]: { enabled: $event.target.checked } })"
          />
          <span>Enabled</span>
        </label>
        <label v-if="s.name === 'atlassian'" class="settings-toggle">
          <input
            type="checkbox"
            :checked="settings.atlassian.autoConnect"
            @change="save({ atlassian: { autoConnect: $event.target.checked } })"
          />
          <span>Reconnect on start when a sign-in is saved (never opens a window)</span>
        </label>
        <label class="integration__field">
          <span>Endpoint</span>
          <input
            :value="settings[s.name].url"
            spellcheck="false"
            @change="save({ [s.name]: { url: $event.target.value } })"
          />
        </label>
        <p v-if="s.st?.tokenFile" class="integration__evidence">
          saved sign-in: <code>{{ s.st.tokenFile }}</code>
        </p>
      </details>
    </article>
    <p v-if="error" class="form-error">{{ error }}</p>
  </div>
</template>
