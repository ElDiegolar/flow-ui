<script setup>
import { onBeforeUnmount, onMounted, nextTick, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { api, streamSession } from '../api.js'

// Reusable xterm + WebSocket panel bound to a daemon session id. Used both by
// CommandRunner (one-off agent and commit sessions) and OrchestratorView (the
// persistent claude session). Chrome (titles, stop/close buttons) lives in the
// parent — this component owns only the terminal and its socket.
const props = defineProps({
  sessionId: { type: String, default: null },
  // Optional async (id) => string|null. When it resolves to saved scrollback,
  // we replay it (with a divider) before attaching the live stream — used to
  // restore a resumed task's history above its fresh process output.
  historyLoader: { type: Function, default: null },
})
const emit = defineEmits(['exit'])

const termRef = ref(null)
let term = null
let fitAddon = null
let ws = null
let resizeObs = null

function sendInput(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data }))
  }
}

// Honor bracketed-paste mode so TUIs (e.g. Claude Code) treat it as a paste,
// not as typed keystrokes that might submit early on a newline.
function sendPaste(text) {
  const bracketed = term?.modes?.bracketedPasteMode
  sendInput(bracketed ? `\x1b[200~${text}\x1b[201~` : text)
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

// xterm.js can't paste images; for an image we upload it and type the saved
// path (which Claude Code can read). Text we send ourselves so paste works
// regardless of xterm's internal focus handling.
//
// We run in the CAPTURE phase and stopPropagation so xterm's own paste handler
// (bound to its inner element/textarea) never also fires — otherwise text would
// be delivered twice. We are the single source for paste.
async function onPaste(e) {
  const items = e.clipboardData ? Array.from(e.clipboardData.items || []) : []
  const image = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'))
  const text = e.clipboardData?.getData('text')
  if (!image && !text) return
  // Claim the paste synchronously, before any await, so xterm's native handler
  // and the browser default don't also act on it.
  e.preventDefault()
  e.stopPropagation()
  if (image) {
    const file = image.getAsFile()
    if (!file) return
    try {
      const { path } = await api.pasteImage(await fileToBase64(file), file.type)
      sendPaste(`${path} `)
    } catch (err) {
      console.error('paste image failed', err)
    }
    return
  }
  sendPaste(text)
}

function focusTerm() {
  term?.focus()
}

// Terminals stay dark in every theme; the palette follows the app theme —
// neutral (Atlassian dark) by default, the original neon under 'cyberpunk'.
const XTERM_THEMES = {
  corporate: {
    fontFamily:
      'ui-monospace, "SFMono-Regular", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace',
    theme: {
      background: '#161718',
      foreground: '#CECFD2',
      cursor: '#669DF1',
      cursorAccent: '#161718',
      selectionBackground: 'rgba(102, 157, 241, 0.30)',
      black: '#2B2C2F',
      red: '#F87168',
      green: '#7EE2B8',
      yellow: '#FBC828',
      blue: '#669DF1',
      magenta: '#D8A0F7',
      cyan: '#9DD9EE',
      white: '#CECFD2',
      brightBlack: '#7E8188',
      brightRed: '#FD9891',
      brightGreen: '#B3DF72',
      brightYellow: '#EED12B',
      brightBlue: '#8FB8F6',
      brightMagenta: '#F797D2',
      brightCyan: '#C6EDFB',
      brightWhite: '#FFFFFF',
    },
  },
  cyberpunk: {
    fontFamily: '"Share Tech Mono", "JetBrains Mono", "SF Mono", Consolas, monospace',
    theme: {
      background: '#03030f',
      foreground: '#e2f0ff',
      cursor: '#05d9e8',
      cursorAccent: '#03030f',
      selectionBackground: 'rgba(5, 217, 232, 0.3)',
      black: '#0d0e24',
      red: '#ff2a6d',
      green: '#2dffb1',
      yellow: '#fcee0a',
      blue: '#05d9e8',
      magenta: '#b300ff',
      cyan: '#05d9e8',
      white: '#e2f0ff',
      brightBlack: '#3e4a72',
      brightRed: '#ff5d92',
      brightGreen: '#6effd0',
      brightYellow: '#fff77a',
      brightBlue: '#6ef0ff',
      brightMagenta: '#d76eff',
      brightCyan: '#6ef0ff',
      brightWhite: '#ffffff',
    },
  },
}
function xtermLook() {
  const t =
    XTERM_THEMES[document.documentElement.dataset.theme === 'cyberpunk' ? 'cyberpunk' : 'corporate']
  return { fontFamily: t.fontFamily, fontSize: 13, theme: t.theme }
}
// Re-skin live terminals when the theme changes (App sets <html data-theme>).
const themeObs = new MutationObserver(() => {
  if (!term) return
  const look = xtermLook()
  term.options.theme = look.theme
  term.options.fontFamily = look.fontFamily
  try {
    fitAddon?.fit()
  } catch {}
})
themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

async function ensureTerminal() {
  // Wait for Vue to render the (possibly newly-visible) container — opening on a
  // 0×0 element silently swallows output.
  await nextTick()
  if (term) {
    try {
      fitAddon?.fit()
    } catch {}
    return
  }
  term = new Terminal({
    ...xtermLook(),
    convertEol: true,
    scrollback: 5000,
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(termRef.value)
  try {
    fitAddon.fit()
  } catch {}

  term.onData((data) => sendInput(data))

  // Ctrl/Cmd+V is the paste shortcut — let the browser's native paste event
  // (handled by onPaste) deliver the content. Returning false stops xterm from
  // emitting the raw ^V (\x16); Claude Code binds ^V to "paste image from
  // clipboard", so a stray ^V hijacks the paste ("No image found in clipboard")
  // and the text never lands. Returning false also leaves the keydown's default
  // intact, so the browser still fires the paste event.
  term.attachCustomKeyEventHandler((e) => {
    if (
      e.type === 'keydown' &&
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      (e.key === 'v' || e.key === 'V')
    ) {
      return false
    }
    return true
  })

  // Robust paste (text + images) and click-to-focus on the container. Capture
  // phase so we run before xterm's own paste handler on the inner element.
  termRef.value.addEventListener('paste', onPaste, true)
  termRef.value.addEventListener('mousedown', focusTerm)

  resizeObs = new ResizeObserver(() => {
    try {
      fitAddon.fit()
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    } catch {}
  })
  resizeObs.observe(termRef.value)
}

function closeWS() {
  if (ws) {
    ws.close()
    ws = null
  }
}

async function attach(id) {
  await ensureTerminal()
  if (term) term.clear()
  closeWS()
  // Replay parked scrollback (if any) above the live session.
  if (props.historyLoader) {
    try {
      const hist = await props.historyLoader(id)
      if (hist && term && props.sessionId === id) {
        term.write(hist.endsWith('\n') ? hist : `${hist}\r\n`)
        term.write('\x1b[2m──── parked history above · live session below ────\x1b[0m\r\n')
      }
    } catch {
      /* no saved history for this session — fine */
    }
  }
  ws = streamSession(id)
  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data)
      if (msg.type === 'data') term.write(msg.data)
      else if (msg.type === 'exit') {
        term.write(`\r\n\x1b[2m[exited ${msg.exitCode}]\x1b[0m\r\n`)
        emit('exit', msg.exitCode)
      } else if (msg.type === 'error') {
        term.write(`\r\n\x1b[31m[error: ${msg.message}]\x1b[0m\r\n`)
      }
    } catch {}
  })
}

defineExpose({
  clear: () => {
    if (term) term.clear()
  },
  detach: closeWS,
})

watch(
  () => props.sessionId,
  (id) => {
    if (id) attach(id)
    else closeWS()
  },
  { flush: 'post' },
)

onMounted(() => {
  if (props.sessionId) attach(props.sessionId)
})

onBeforeUnmount(() => {
  themeObs.disconnect()
  closeWS()
  if (resizeObs) resizeObs.disconnect()
  if (termRef.value) {
    termRef.value.removeEventListener('paste', onPaste, true)
    termRef.value.removeEventListener('mousedown', focusTerm)
  }
  if (term) term.dispose()
})
</script>

<template>
  <div ref="termRef" class="terminal-panel"></div>
</template>
