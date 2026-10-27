<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import AiSetupCard from '../components/AiSetupCard.vue'
import InfoTip from '../components/InfoTip.vue'
import IntegrationsPanel from '../components/IntegrationsPanel.vue'
import ModelsPanel from '../components/ModelsPanel.vue'
import { api, errorText } from '../api.js'
import { loadModels, models } from '../models.js'
import { applyTabSettings, claudeReadiness, store } from '../store.js'

const emit = defineEmits(['rerun-setup', 'session-start', 'workspace-changed'])

const setup = ref(null)
const settings = ref(null)
const error = ref(null)
const busy = ref(false)

// Tabs the user can switch off. Tasks, Orchestrator and Setup are the core flow.
const SECTION_ROWS = [
  { id: 'tasks', label: 'Tasks', core: true, blurb: 'The board every task starts from' },
  {
    id: 'orchestrator',
    label: 'Orchestrator',
    core: true,
    blurb: 'Plans the work and delegates it',
  },
  { id: 'agent', label: 'Agent', blurb: 'Start a coding agent directly' },
  { id: 'commit', label: 'Commit', blurb: 'Commit the changes in one repo' },
  { id: 'diff', label: 'Diff', blurb: 'What the agents changed, per repo' },
  { id: 'setup', label: 'Setup', core: true, blurb: 'This page' },
]
const OPTIONAL_TABS = SECTION_ROWS.filter((r) => !r.core)
const tabOn = (id) => settings.value?.tabs?.[id] !== false
const optionalOn = computed(() => OPTIONAL_TABS.filter((r) => tabOn(r.id)).length)

const MCP_SERVERS = ['atlassian', 'figma']
const mcpConnected = computed(
  () => MCP_SERVERS.filter((n) => store.integrations?.[n]?.state === 'connected').length,
)

// Cards: one place for order, titles and what each one needs before it shows.
const CARDS = [
  {
    id: 'sections',
    title: 'Sections',
    blurb:
      'Which tabs show in the top bar. Hidden tabs can still open when something sends you there.',
  },
  {
    id: 'agents',
    title: 'Coding agents',
    blurb: 'The engines the orchestrator delegates work to.',
  },
  {
    id: 'mcp',
    title: 'MCP servers',
    blurb: 'Held by Flow — one connection each, shared by every agent.',
  },
  { id: 'models', title: 'Models', blurb: 'Which model each agent runs on.', needs: 'settings' },
  { id: 'behaviour', title: 'Behaviour', blurb: 'Takes effect immediately.', needs: 'settings' },
  {
    id: 'workspace',
    title: 'Workspace',
    blurb: 'The folder of repos Flow works in, and how it was found.',
  },
  {
    id: 'wiring',
    title: 'Wiring',
    blurb: 'What the orchestrator is launched with.',
    needs: 'setup',
  },
]
const visibleCards = computed(() =>
  CARDS.filter((c) => !c.needs || (c.needs === 'settings' ? settings.value : setup.value)),
)

// Collapsible cards. Wiring (read-only, advanced) starts closed. Remembered per browser.
const OPEN_KEY = 'flow-ui:setup-open'
const DEFAULT_OPEN = {
  sections: true,
  agents: true,
  mcp: true,
  models: true,
  behaviour: true,
  workspace: true,
  wiring: false,
}
function readOpen() {
  try {
    return { ...DEFAULT_OPEN, ...JSON.parse(localStorage.getItem(OPEN_KEY) || '{}') }
  } catch {
    return { ...DEFAULT_OPEN }
  }
}
const open = ref(readOpen())
watch(
  open,
  (value) => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(value))
    } catch {
      /* storage blocked: the cards just open by default next time */
    }
  },
  { deep: true },
)
function toggle(id) {
  open.value = { ...open.value, [id]: !open.value[id] }
}
// Clicking the empty part of a header toggles the card. Buttons, links, inputs and
// the ⓘ note keep their own clicks.
function onHeadClick(e, id) {
  if (e.target.closest('button, a, input, select, textarea, .infotip')) return
  toggle(id)
}

// Section nav: open the target card if it is closed, then scroll to it.
const NAV = [
  { id: 'sections', label: 'Sections' },
  { id: 'agents', label: 'Coding agents' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'models', label: 'Models' },
  { id: 'behaviour', label: 'Behaviour' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'wiring', label: 'Wiring' },
]
async function jump(id) {
  open.value = { ...open.value, [id]: true }
  await nextTick()
  document.getElementById(`setup-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

const checksFor = (group) => setup.value?.checks?.filter((c) => c.group === group) ?? []

const blocking = computed(() =>
  (setup.value?.checks ?? []).filter((c) => c.required && c.status !== 'ready'),
)

// "1 blocking" when a required check in the group is not ready, else "2 ready".
function checkHint(list) {
  if (!list.length) return { text: '' }
  const blockingN = list.filter((c) => c.required && c.status !== 'ready').length
  if (blockingN) return { text: `${blockingN} blocking`, warn: true }
  return { text: `${list.filter((c) => c.status === 'ready').length} ready` }
}

// Header hints (right of each card title). Derived from data already loaded.
const mcpIssues = computed(
  () =>
    (setup.value?.checks ?? []).filter((c) => c.group === 'mcp' && c.status === 'missing').length,
)
const hints = computed(() => {
  const mcpText = store.integrations
    ? `${mcpConnected.value} of ${MCP_SERVERS.length} connected`
    : ''
  return {
    sections: { text: settings.value ? `${optionalOn.value} of ${OPTIONAL_TABS.length} on` : '' },
    agents: checkHint(checksFor('agent')),
    mcp: mcpIssues.value
      ? {
          text: [mcpText, `${mcpIssues.value} need attention`].filter(Boolean).join(' · '),
          warn: true,
        }
      : { text: mcpText },
    models: { text: models.value.length ? `${models.value.length} models` : '' },
    behaviour: { text: settings.value?.jiraReadOnly ? 'Jira read-only on' : '' },
    workspace: checkHint(checksFor('host')),
    wiring: { text: '' },
  }
})

// One line under the title: checks ready, blocking, MCP connections, models.
const summary = computed(() => {
  if (!setup.value) return []
  const all = setup.value.checks ?? []
  const ready = all.filter((c) => c.status === 'ready').length
  const parts = [{ text: `${ready} of ${all.length} checks ready` }]
  parts.push(
    blocking.value.length
      ? { text: `${blocking.value.length} blocking`, tone: 'is-warn' }
      : { text: 'nothing blocking', tone: 'is-ok' },
  )
  parts.push({
    text: store.integrations
      ? `${mcpConnected.value} of ${MCP_SERVERS.length} MCP connected`
      : 'MCP not checked yet',
  })
  parts.push({ text: `${models.value.length} models` })
  return parts
})

async function refresh() {
  busy.value = true
  error.value = null
  try {
    setup.value = await api.setup.get()
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}

async function loadSettings() {
  // loadModels fetches the settings and fills the shared model list with them.
  settings.value = (await loadModels()) ?? settings.value
  if (settings.value) applyTabSettings(settings.value)
}

async function saveSetting(patch) {
  try {
    settings.value = await api.settings.update(patch)
    applyTabSettings(settings.value)
  } catch (e) {
    error.value = errorText(e)
  }
}
const toggleJiraReadOnly = () => saveSetting({ jiraReadOnly: !settings.value?.jiraReadOnly })

// Core tabs are never switched off. For the optional ones, show the saved state
// (also when the save failed), so the checkbox never disagrees with the server.
async function setTab(row, e) {
  if (row.core) return
  const box = e.target
  await saveSetting({ tabs: { [row.id]: box.checked } })
  box.checked = tabOn(row.id)
}

// The AI Setup card's session ended: re-read the checks and the header's
// workspace name, so the new categories and repos show without a reload.
function onSetupDone() {
  refresh()
  emit('workspace-changed')
}

// AI Setup runs on claude; its button is gated on that check.
const claude = computed(() => claudeReadiness(setup.value))

// Copy a fix command so it can be pasted into a terminal — the daemon never
// runs these itself: each one is a login flow owned by that CLI.
const copied = ref(null)

async function copyFix(cmd, id) {
  try {
    await navigator.clipboard.writeText(cmd)
    copied.value = id
    setTimeout(() => {
      if (copied.value === id) copied.value = null
    }, 1500)
  } catch {
    /* clipboard blocked — the command is on screen to copy by hand */
  }
}

onMounted(() => {
  refresh()
  loadSettings()
})
</script>

<template>
  <section class="settings-view">
    <header class="settings-view__bar">
      <h2 class="view-title">Setup</h2>
      <span v-if="setup" class="settings-view__state" :class="setup.ready ? 'ok' : 'bad'">
        {{ setup.ready ? 'ready' : `${blocking.length} blocking` }}
      </span>
      <button class="btn" :disabled="busy" @click="refresh">
        {{ busy ? 'Checking…' : 'Re-check' }}
      </button>
      <button
        class="btn"
        title="Walk through connecting Jira and Figma again"
        @click="emit('rerun-setup')"
      >
        Re-run setup
      </button>
    </header>

    <p v-if="summary.length" class="settings-view__summary">
      <span v-for="(s, i) in summary" :key="i" :class="s.tone">{{ s.text }}</span>
    </p>

    <nav class="settings-nav" aria-label="Jump to a setup section">
      <a
        v-for="n in NAV"
        :key="n.id"
        class="settings-nav__chip"
        :href="`#setup-${n.id}`"
        @click.prevent="jump(n.id)"
      >
        {{ n.label }}
      </a>
    </nav>

    <p v-if="error" class="settings-view__error">{{ error }}</p>

    <div v-if="setup?.unconfigured" class="settings-view__firstrun">
      <strong>Nothing is authenticated yet.</strong>
      Flow drives your coding agents — until at least one agent is logged in and a workspace exists,
      starting a task will spawn an agent that fails immediately. Work through the checks below;
      each one names the command that fixes it.
    </div>

    <div
      v-for="card in visibleCards"
      :id="`setup-${card.id}`"
      :key="card.id"
      class="settings-group settings-card"
    >
      <div class="settings-group__head settings-card__head" @click="onHeadClick($event, card.id)">
        <h3 class="settings-card__title">
          <button
            type="button"
            class="settings-card__toggle"
            :aria-expanded="open[card.id] ? 'true' : 'false'"
            :aria-controls="`setup-body-${card.id}`"
            @click="toggle(card.id)"
          >
            <span class="settings-card__chev" aria-hidden="true"></span>
            {{ card.title }}
          </button>
        </h3>
        <InfoTip v-if="card.id === 'sections'" label="How to use Sections">
          Switching a tab off removes it from the top bar. It never disables the feature: anything
          that sends you to a hidden tab still opens it. <strong>Tasks</strong>,
          <strong>Orchestrator</strong> and <strong>Setup</strong> are the core flow and always stay
          on.
        </InfoTip>
        <InfoTip v-else-if="card.id === 'agents'" label="How to use Coding agents">
          The two command-line tools every agent runs through: <strong>Claude Code</strong> and
          <strong>Codex</strong>. Each check shows whether the tool is installed and logged in. If
          one is red, copy the command under it, run it in a terminal, then press
          <strong>Re-check</strong>. A tool only needs its own login when a model uses it
          <em>without</em> a custom endpoint (see Models).
        </InfoTip>
        <InfoTip v-else-if="card.id === 'mcp'" label="How to use MCP servers">
          Jira (Atlassian) and Figma, held by Flow itself: one sign-in each, shared by every agent.
          <strong>Connect</strong> opens the provider's login once; after that the token is reused.
          Use <strong>Reset → Connect</strong> if a login is missing permissions (e.g. Jira access).
          Turning one off here takes it away from every agent.
        </InfoTip>
        <InfoTip v-else-if="card.id === 'models'" label="How to use Models">
          Pick which model backs the <strong>orchestrator</strong> and which one
          <strong>sub-agents</strong> get by default. The orchestrator can still start a sub-agent
          on any model by its ID. To add a model, press <strong>Add model</strong>, optionally start
          from a preset, and give it a base URL, a model name and a key if the server needs one. Use
          <strong>Test</strong> to check that the endpoint answers and serves that model.
          <em>Runs through</em> is the CLI that drives it: Claude Code for Anthropic-compatible
          servers (OpenRouter, llama.cpp, Ollama), Codex for OpenAI-compatible ones. To hot-swap a
          running orchestrator, pick the model in the Orchestrator tab and press
          <strong>Restart</strong>. Sub-agents that are already running keep their model.
        </InfoTip>
        <InfoTip v-else-if="card.id === 'behaviour'" label="How to use Behaviour">
          <strong>Jira read-only</strong> blocks every agent from creating, editing, moving or
          commenting on Jira issues. Reading still works. <strong>Board sync</strong> sets how often
          the Tasks board pulls from your Jira board while connected.
          <strong>Figma assets</strong> is one folder, outside every project, where Figma's
          design-context call writes the frame's files; clear it to stop writing. All apply straight
          away.
        </InfoTip>
        <InfoTip v-else-if="card.id === 'workspace'" label="How to use Workspace">
          Flow works on the git repos in one workspace folder, grouped as
          <code>projects/&lt;category&gt;/&lt;repo&gt;</code>. <strong>AI Setup</strong> finds the
          repos in a folder you choose and links them in as symlinks, so nothing is moved or copied.
          Run it again whenever you add a repo. To use a folder you set up yourself, start Flow with
          <code>FLOW_WORKSPACE</code> pointing at it.
        </InfoTip>
        <InfoTip v-else label="How to use Wiring">
          Read-only: the workspace and MCP config the orchestrator is launched with. Check here when
          an agent is working in the wrong folder or can't see a tool. It changes when the daemon's
          environment changes, not from this page.
        </InfoTip>
        <span class="settings-group__blurb">{{ card.blurb }}</span>
        <span
          v-if="hints[card.id]?.text"
          class="settings-card__hint"
          :class="{ 'is-warn': hints[card.id].warn }"
          >{{ hints[card.id].text }}</span
        >
      </div>

      <div :id="`setup-body-${card.id}`" v-show="open[card.id]" class="settings-card__body">
        <div v-if="card.id === 'sections'" class="settings-sections">
          <label
            v-for="row in SECTION_ROWS"
            :key="row.id"
            class="settings-toggle"
            :class="{ 'is-locked': row.core }"
          >
            <input
              type="checkbox"
              :checked="row.core ? true : tabOn(row.id)"
              :disabled="row.core || !settings"
              @change="setTab(row, $event)"
            />
            <span>
              <strong>{{ row.label }}</strong>
              — {{ row.blurb }}
              <span v-if="row.core" class="settings-toggle__tag">always on</span>
            </span>
          </label>
        </div>

        <template v-else-if="card.id === 'agents' || card.id === 'workspace'">
          <AiSetupCard
            v-if="card.id === 'workspace'"
            :ready="claude.ready"
            :reason="claude.reason"
            @session-start="emit('session-start', $event)"
            @session-done="onSetupDone"
          />
          <article
            v-for="c in checksFor(card.id === 'agents' ? 'agent' : 'host')"
            :key="c.id"
            class="check"
            :class="c.status"
          >
            <span class="check__dot" :class="c.status"></span>
            <div class="check__body">
              <div class="check__title">
                {{ c.label }}
                <span class="check__tag">{{ c.required ? 'required' : 'optional' }}</span>
              </div>
              <div class="check__detail">{{ c.detail }}</div>
              <div v-if="c.fix" class="check__fix">
                <code>{{ c.fix }}</code>
                <button class="btn" @click="copyFix(c.fix, c.id)">
                  {{ copied === c.id ? 'Copied' : 'Copy' }}
                </button>
              </div>
              <div v-if="c.evidence" class="check__evidence" :title="c.evidence">
                found at {{ c.evidence }}
              </div>
            </div>
          </article>
        </template>

        <template v-else-if="card.id === 'mcp'">
          <p
            v-for="c in (setup?.checks ?? []).filter((c) => c.group === 'mcp' && c.fix)"
            :key="c.id"
            class="check__detail"
          >
            <strong>{{ c.label }}:</strong> {{ c.detail }} — {{ c.fix }}
          </p>
          <IntegrationsPanel @changed="refresh" />
        </template>

        <ModelsPanel
          v-else-if="card.id === 'models'"
          :settings="settings"
          @saved="settings = $event"
        />

        <template v-else-if="card.id === 'behaviour'">
          <label class="settings-toggle">
            <input type="checkbox" :checked="settings.jiraReadOnly" @change="toggleJiraReadOnly" />
            <span>
              <strong>Jira read-only</strong>
              — when on, Flow refuses any agent call that would create, edit, transition or comment
              on a Jira issue.
            </span>
          </label>
          <label class="settings-inline">
            <span><strong>Board sync</strong> — re-sync the selected Jira board every</span>
            <select
              :value="settings.jiraSyncMinutes"
              @change="saveSetting({ jiraSyncMinutes: Number($event.target.value) })"
            >
              <option :value="0">never (manual)</option>
              <option :value="2">2 minutes</option>
              <option :value="5">5 minutes</option>
              <option :value="15">15 minutes</option>
              <option :value="60">hour</option>
            </select>
          </label>
          <label class="settings-inline">
            <span
              ><strong>Figma assets</strong> — images and vectors from the selected Figma frame are
              saved to</span
            >
            <input
              type="text"
              :value="settings.figma?.assetsDir"
              placeholder="off"
              spellcheck="false"
              @change="saveSetting({ figma: { assetsDir: $event.target.value } })"
            />
          </label>
        </template>

        <div v-else-if="card.id === 'wiring'" class="settings-facts">
          <div>
            <span>workspace</span><code>{{ setup.workspace ?? 'none — run AI Setup' }}</code>
          </div>
          <div>
            <span>MCP config</span><code>{{ setup.mcpConfigPath }}</code>
          </div>
          <div>
            <span>MCP servers</span>
            <code>{{
              setup.mcpServers.length ? setup.mcpServers.join(', ') : 'none written yet'
            }}</code>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
