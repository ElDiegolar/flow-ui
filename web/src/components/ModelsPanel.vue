<script setup>
// Setup → Models: which model backs the orchestrator and sub-agents, and the
// custom model profiles behind those pickers (daemon/src/models.ts). API keys
// are write-only — the daemon never sends them back, only `hasKey`.
import { computed, ref } from 'vue'
import { api, errorText } from '../api.js'
import { models, modelOption } from '../models.js'

const props = defineProps({ settings: { type: Object, required: true } })
const emit = defineEmits(['saved'])

const error = ref(null)
const saving = ref(false)
const custom = computed(() => models.value.filter((m) => !m.builtin))

// Quick-fills for the endpoints this workspace actually uses. Each is only a
// starting point — the model name still has to match what the server serves.
const PRESETS = [
  {
    name: 'Local llama.cpp (:8081)',
    engine: 'claude',
    baseUrl: 'http://127.0.0.1:8081',
    model: '',
    note: 'llama-server speaks the Anthropic API at /v1/messages. Model = the served GGUF alias.',
  },
  {
    name: 'OpenRouter',
    engine: 'claude',
    baseUrl: 'https://openrouter.ai/api',
    model: 'qwen/qwen3-coder',
    note: 'Needs an OpenRouter key. Model = any OpenRouter model id.',
  },
  {
    name: 'Ollama',
    engine: 'claude',
    baseUrl: 'http://127.0.0.1:11434',
    model: '',
    note: 'Ollama ≥ 0.14 serves the Anthropic API. Model = an `ollama list` name.',
  },
  {
    name: 'OpenAI-compatible (via Codex)',
    engine: 'codex',
    baseUrl: 'http://127.0.0.1:8081/v1',
    model: '',
    wireApi: 'chat',
    note: 'Any /v1/chat/completions server, driven through the Codex CLI.',
  },
]

const blank = () => ({
  id: '',
  label: '',
  engine: 'claude',
  model: '',
  baseUrl: '',
  apiKey: '',
  clearKey: false,
  wireApi: 'responses',
  hasKey: false,
  isNew: true,
})
const form = ref(null) // the profile being added/edited, or null
const presetNote = ref('')
const test = ref(null) // { ok, detail, models? } | { pending: true }

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

function startAdd() {
  form.value = blank()
  presetNote.value = ''
  test.value = null
}
function startEdit(m) {
  form.value = { ...blank(), ...m, model: m.model ?? '', baseUrl: m.baseUrl ?? '', isNew: false }
  form.value.wireApi = m.wireApi ?? 'responses'
  presetNote.value = ''
  test.value = null
}
function applyPreset(e) {
  const p = PRESETS.find((x) => x.name === e.target.value)
  e.target.value = ''
  if (!p || !form.value) return
  Object.assign(form.value, {
    engine: p.engine,
    baseUrl: p.baseUrl,
    model: p.model || form.value.model,
    wireApi: p.wireApi ?? 'responses',
  })
  if (!form.value.label) form.value.label = p.name
  onLabel()
  presetNote.value = p.note
}
function onLabel() {
  if (form.value.isNew) form.value.id = slug(form.value.label)
}

// What the daemon stores for a profile. `apiKey` omitted = keep the stored key.
function payload(m, edited) {
  const out = {
    id: m.id,
    label: m.label,
    engine: m.engine,
    model: m.model || undefined,
    baseUrl: m.baseUrl || undefined,
    wireApi: m.engine === 'codex' && m.baseUrl ? m.wireApi : undefined,
  }
  if (edited) {
    if (m.clearKey) out.apiKey = ''
    else if (m.apiKey) out.apiKey = m.apiKey
  }
  return out
}

async function persist(list, extra = {}) {
  saving.value = true
  error.value = null
  try {
    const s = await api.settings.update({ models: list, ...extra })
    models.value = s.models
    emit('saved', s)
    return true
  } catch (e) {
    error.value = errorText(e)
    return false
  } finally {
    saving.value = false
  }
}

async function save() {
  const f = form.value
  if (!f.id) f.id = slug(f.label)
  const others = custom.value.filter((m) => m.id !== f.id || f.isNew).map((m) => payload(m, false))
  if (await persist([...others, payload(f, true)])) form.value = null
}

async function remove(m) {
  if (!confirm(`Delete the "${m.label}" model profile?`)) return
  await persist(custom.value.filter((x) => x.id !== m.id).map((x) => payload(x, false)))
}

async function runTest() {
  const f = form.value
  test.value = { pending: true }
  try {
    test.value = await api.settings.testModel({
      ...payload(f, true),
      id: f.isNew ? undefined : f.id,
    })
  } catch (e) {
    test.value = { ok: false, detail: errorText(e) }
  }
}

async function pick(field, id) {
  error.value = null
  try {
    emit('saved', await api.settings.update({ [field]: id }))
  } catch (e) {
    error.value = errorText(e)
  }
}
</script>

<template>
  <div class="models">
    <div class="models__pickers">
      <label class="settings-inline">
        <span><strong>Orchestrator</strong> runs on</span>
        <select
          :value="props.settings.orchestratorAgent"
          @change="pick('orchestratorAgent', $event.target.value)"
        >
          <option v-for="m in models" :key="m.id" :value="m.id">{{ modelOption(m) }}</option>
        </select>
      </label>
      <label class="settings-inline">
        <span><strong>Sub-agents</strong> default to</span>
        <select
          :value="props.settings.subagentDefault"
          @change="pick('subagentDefault', $event.target.value)"
        >
          <option v-for="m in models" :key="m.id" :value="m.id">{{ modelOption(m) }}</option>
        </select>
      </label>
    </div>

    <table class="models__table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Runs through</th>
          <th>Model</th>
          <th>Endpoint</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="m in models" :key="m.id">
          <td>
            <strong>{{ m.label }}</strong> <code class="models__id">{{ m.id }}</code>
          </td>
          <td>{{ m.engine }} CLI</td>
          <td>{{ m.model || 'CLI default' }}</td>
          <td class="models__endpoint">
            <template v-if="m.baseUrl"
              >{{ m.baseUrl }}<span v-if="m.hasKey" class="models__key"> · key set</span></template
            >
            <span v-else class="models__faint">{{ m.engine }} login</span>
          </td>
          <td class="models__actions">
            <template v-if="!m.builtin">
              <button class="btn" :disabled="saving" @click="startEdit(m)">Edit</button>
              <button class="btn danger" :disabled="saving" @click="remove(m)">Delete</button>
            </template>
            <span v-else class="models__faint">built-in</span>
          </td>
        </tr>
      </tbody>
    </table>

    <button v-if="!form" class="btn primary" @click="startAdd">Add model</button>

    <form v-else class="models__form" @submit.prevent="save">
      <h4>{{ form.isNew ? 'Add model' : `Edit ${form.label}` }}</h4>
      <div v-if="form.isNew" class="form-row">
        <label>Start from</label>
        <select @change="applyPreset">
          <option value="">— preset (optional) —</option>
          <option v-for="p in PRESETS" :key="p.name" :value="p.name">{{ p.name }}</option>
        </select>
      </div>
      <p v-if="presetNote" class="hint">{{ presetNote }}</p>
      <div class="form-row">
        <label>Name</label>
        <input v-model="form.label" required placeholder="e.g. Qwen local" @input="onLabel" />
      </div>
      <div class="form-row">
        <label>ID</label>
        <input
          v-model="form.id"
          :disabled="!form.isNew"
          required
          pattern="[a-z0-9][a-z0-9_\-]*"
          title="lowercase letters, digits, - or _ — what run_agent calls it"
        />
      </div>
      <div class="form-row">
        <label>Runs through</label>
        <select v-model="form.engine">
          <option value="claude">Claude Code CLI (Anthropic-compatible API)</option>
          <option value="codex">Codex CLI (OpenAI-compatible API)</option>
        </select>
      </div>
      <div class="form-row">
        <label>Model</label>
        <input v-model="form.model" placeholder="blank = the CLI's default model" />
      </div>
      <div class="form-row">
        <label>Base URL</label>
        <input
          v-model="form.baseUrl"
          type="url"
          placeholder="blank = the CLI's own login (Anthropic / OpenAI)"
        />
      </div>
      <div v-if="form.baseUrl" class="form-row">
        <label>API key</label>
        <input
          v-model="form.apiKey"
          type="password"
          autocomplete="off"
          :disabled="form.clearKey"
          :placeholder="
            form.hasKey ? 'saved — leave blank to keep it' : 'blank if the server needs none'
          "
        />
      </div>
      <label v-if="form.baseUrl && form.hasKey" class="settings-toggle">
        <input v-model="form.clearKey" type="checkbox" /> <span>Remove the saved key</span>
      </label>
      <div v-if="form.engine === 'codex' && form.baseUrl" class="form-row">
        <label>API shape</label>
        <select v-model="form.wireApi">
          <option value="responses">Responses API (/v1/responses)</option>
          <option value="chat">Chat Completions (/v1/chat/completions)</option>
        </select>
      </div>

      <div v-if="test" class="models__test" :class="test.pending ? '' : test.ok ? 'ok' : 'bad'">
        <template v-if="test.pending">Testing…</template>
        <template v-else>
          {{ test.detail }}
          <details v-if="test.models?.length">
            <summary>Models it lists</summary>
            <code>{{ test.models.join(', ') }}</code>
          </details>
        </template>
      </div>

      <div class="models__formactions">
        <button class="btn primary" type="submit" :disabled="saving">Save</button>
        <button class="btn" type="button" :disabled="!form.baseUrl" @click="runTest">Test</button>
        <button class="btn" type="button" @click="form = null">Cancel</button>
      </div>
    </form>

    <p v-if="error" class="settings-view__error">{{ error }}</p>
  </div>
</template>
