<script setup>
import { ref, watch } from 'vue'
import TerminalPanel from './TerminalPanel.vue'
import { api } from '../api.js'

const props = defineProps({
  session: { type: Object, default: null },
})
const emit = defineEmits(['clear'])

const exitInfo = ref(null)

watch(
  () => props.session?.id,
  () => {
    exitInfo.value = null
  },
)

function onExit(code) {
  exitInfo.value = code
}

async function kill() {
  if (!props.session) return
  try {
    await api.killSession(props.session.id)
  } catch (e) {
    console.error(e)
  }
}

function clear() {
  emit('clear')
}
</script>

<template>
  <section class="runner">
    <header class="runner__head">
      <div class="runner__title">
        <span v-if="session"><span class="label">▶</span> {{ session.label }}</span>
        <span v-else style="color: var(--text-dim)">No active session</span>
      </div>
      <div style="display: flex; gap: 0.4rem; align-items: center">
        <span v-if="exitInfo !== null" class="runner__exit">exit {{ exitInfo }}</span>
        <button v-if="session && exitInfo === null" class="btn danger" @click="kill">Stop</button>
        <button v-if="session" class="btn" @click="clear">Close</button>
      </div>
    </header>
    <div v-show="session" class="runner__body">
      <TerminalPanel :session-id="session?.id ?? null" @exit="onExit" />
    </div>
    <div v-if="!session" class="runner__empty">
      Start an agent or a commit and its terminal streams here.
    </div>
  </section>
</template>
