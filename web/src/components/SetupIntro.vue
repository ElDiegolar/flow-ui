<script setup>
/**
 * First-run intro: point Flow at the developer's code (AI Setup), then the two
 * optional sign-ins. Shown until it is finished or skipped (settings.onboardedAt),
 * and re-openable from Setup → "Re-run setup". Every step can be skipped —
 * nothing here blocks the app, it only makes the sign-ins happen at a moment
 * the developer chose.
 */
import { computed, onMounted, ref } from 'vue'
import AiSetupCard from './AiSetupCard.vue'
import IntegrationsPanel from './IntegrationsPanel.vue'
import { api, errorText } from '../api.js'
import { claudeReadiness, store } from '../store.js'

const emit = defineEmits(['done', 'session-start'])

const steps = [
  { id: 'workspace', title: 'Your code' },
  { id: 'atlassian', title: 'Jira' },
  { id: 'figma', title: 'Figma' },
  { id: 'board', title: 'Your board' },
]
const setup = ref(null)
const claude = computed(() => claudeReadiness(setup.value))
const step = ref(0)
const current = computed(() => steps[step.value].id)

const jira = ref(null)
const boardBusy = ref(false)
const boardError = ref(null)
const atlassianUp = computed(() => store.integrations?.atlassian?.state === 'connected')

async function loadSetup() {
  try {
    setup.value = await api.setup.get()
  } catch {
    /* the card shows its own "checking" state */
  }
}

async function loadJira() {
  try {
    jira.value = await api.jira.get()
  } catch {
    /* shown as empty */
  }
}

async function discover() {
  boardBusy.value = true
  boardError.value = null
  try {
    jira.value = { ...jira.value, ...(await api.jira.discover()) }
  } catch (e) {
    boardError.value = errorText(e)
  } finally {
    boardBusy.value = false
  }
}

async function pick(id) {
  jira.value = { ...jira.value, ...(await api.jira.selectBoard(id)) }
}

async function finish() {
  try {
    await api.settings.update({ onboardedAt: Date.now() })
  } catch {
    /* still close — worst case it shows again next load */
  }
  emit('done')
}

function next() {
  if (step.value < steps.length - 1) step.value++
  else finish()
}

onMounted(() => {
  loadSetup()
  loadJira()
})
</script>

<template>
  <div class="intro-overlay" role="dialog" aria-modal="true" aria-labelledby="intro-title">
    <div class="intro">
      <header class="intro__head">
        <h2 id="intro-title">Set up Flow</h2>
        <button class="btn subtle" @click="finish">Skip for now</button>
      </header>

      <ol class="intro__steps">
        <li
          v-for="(s, i) in steps"
          :key="s.id"
          :class="{ active: i === step, done: i < step }"
          @click="step = i"
        >
          <span class="intro__num">{{ i < step ? '✓' : i + 1 }}</span>
          <span>{{ s.title }}</span>
        </li>
      </ol>

      <section class="intro__body">
        <template v-if="current === 'workspace'">
          <h3 class="intro__heading">Point Flow at your code</h3>
          <p>
            Flow runs an orchestrator agent that hands your tasks to coding agents, one per repo. AI
            Setup finds the git repos in a folder you choose, groups them, and writes the workspace
            Flow works from. Your repos are linked, not moved or copied, and nothing in them is
            modified.
          </p>
          <AiSetupCard
            :ready="claude.ready"
            :reason="claude.reason"
            @session-start="emit('session-start', $event)"
          />
          <p class="intro__note">
            Skip this if you already have a workspace; you can run AI Setup later from
            <strong>Setup</strong>.
          </p>
        </template>

        <template v-else-if="current === 'atlassian'">
          <p class="intro__note">
            Optional. Connect Jira to sign in once; the board then becomes your task list. You can
            skip this.
          </p>
          <IntegrationsPanel :only="['atlassian']" compact />
        </template>

        <template v-else-if="current === 'figma'">
          <p class="intro__note">
            Optional. Connect Figma Desktop so agents can read the designs your tasks link to. You
            can skip this.
          </p>
          <IntegrationsPanel :only="['figma']" compact />
        </template>

        <template v-else>
          <p v-if="!atlassianUp" class="intro__note">
            Connect Jira first (step 2) — the board list comes from your Jira account.
          </p>
          <template v-else>
            <p>
              Pick the board you work from. Tasks shows its open issues assigned to you, and clears
              them when they're done in Jira.
            </p>
            <div class="intro__boards">
              <button
                v-for="b in jira?.boards ?? []"
                :key="b.id"
                class="intro__board"
                :class="{ selected: b.id === jira.selectedId }"
                @click="pick(b.id)"
              >
                <strong>{{ b.name }}</strong>
                <span>{{ b.key }}{{ b.site ? ` · ${b.site}` : '' }}</span>
                <span v-if="b.issueCount != null" class="lozenge neutral"
                  >{{ b.issueCount }} open</span
                >
              </button>
            </div>
            <button class="btn" :disabled="boardBusy" @click="discover">
              {{ boardBusy ? 'Looking…' : jira?.boards?.length ? 'Look again' : 'Find my boards' }}
            </button>
            <p v-if="boardError" class="form-error">{{ boardError }}</p>
          </template>
        </template>
      </section>

      <footer class="intro__foot">
        <button class="btn subtle" :disabled="step === 0" @click="step--">Back</button>
        <button class="btn primary" @click="next">
          {{ step === steps.length - 1 ? 'Finish' : 'Continue' }}
        </button>
      </footer>
    </div>
  </div>
</template>
