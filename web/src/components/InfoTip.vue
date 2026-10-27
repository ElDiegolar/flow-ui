<script setup>
// A small ⓘ button that opens a "how to use this" note. Click (or Enter/Space)
// toggles it; Escape or a click elsewhere closes it. The note is the default slot.
import { onBeforeUnmount, onMounted, ref } from 'vue'

defineProps({ label: { type: String, default: 'How to use this' } })

const open = ref(false)
const root = ref(null)
const id = `infotip-${Math.random().toString(36).slice(2, 9)}`

function onDocClick(e) {
  if (open.value && root.value && !root.value.contains(e.target)) open.value = false
}
function onKey(e) {
  if (e.key === 'Escape') open.value = false
}
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <span ref="root" class="infotip">
    <button
      type="button"
      class="infotip__btn"
      :aria-label="label"
      :aria-expanded="open"
      :aria-controls="id"
      :title="label"
      @click="open = !open"
    >
      i
    </button>
    <span v-if="open" :id="id" class="infotip__note" role="note">
      <slot />
    </span>
  </span>
</template>
