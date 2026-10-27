// Model profiles (daemon/src/models.ts), shared by every agent picker. Setup
// owns editing them; the pickers only read. Seeded with the two built-ins so a
// picker renders before the first fetch lands.
import { ref } from 'vue'
import { api } from './api.js'

export const models = ref([
  { id: 'claude', label: 'Claude', engine: 'claude', builtin: true },
  { id: 'codex', label: 'Codex', engine: 'codex', builtin: true },
])

export async function loadModels() {
  try {
    const s = await api.settings.get()
    if (Array.isArray(s.models)) models.value = s.models
    return s
  } catch {
    return null // keep the built-ins
  }
}

export const modelLabel = (id) => models.value.find((m) => m.id === id)?.label ?? id

/** One-line description for a picker option: label, and the model if custom. */
export const modelOption = (m) =>
  m.builtin
    ? m.label
    : `${m.label} — ${m.model || m.engine}${m.baseUrl ? ' (custom endpoint)' : ''}`
