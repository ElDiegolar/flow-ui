import { randomUUID } from 'node:crypto'
import { spawn, type IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import type { Invocation, PromptAnswer } from './common/types.ts'

export type SessionListener = (data: string) => void
export type SessionExitListener = (exitCode: number, signal: number) => void

/** How a session relates to the orchestrator. 'command' = a one-off process
 * (git commit, AI setup) or a UI-launched agent; 'orchestrator' = the long-lived control
 * agent; 'subagent' = an agent the orchestrator spawned via run_agent. */
export type SessionKind = 'orchestrator' | 'subagent' | 'command'

export type Session = {
  id: string
  invocation: Invocation
  pty: IPty
  output: string
  buffer: string
  /** Indexes into `invocation.prompts` already answered this session. */
  promptsAnswered: Set<number>
  listeners: Set<SessionListener>
  exitListeners: Set<SessionExitListener>
  exited: boolean
  exitCode: number | null
  startedAt: number
  /** Parent session that spawned this one (the orchestrator, for subagents). */
  parentId: string | null
  kind: SessionKind
  /** Free-form role, e.g. the agent name ('codex' | 'claude'). */
  role: string | null
  /** True when the session needs the developer (a prompt, or it's gone long-idle). */
  awaitingInput: boolean
  /** Why: a recognised prompt, or a long idle with no output. */
  awaitReason: 'prompt' | 'idle' | null
  /** Last time the PTY emitted output (for idle detection). */
  lastOutputAt: number
}

const sessions = new Map<string, Session>()

/** The outward-facing shape of a session (no pty handle / buffers). This is
 * the single projection consumed by /api/sessions and the event stream. */
export type SessionSummary = {
  id: string
  label: string
  exited: boolean
  exitCode: number | null
  startedAt: number
  parentId: string | null
  kind: SessionKind
  role: string | null
  awaitingInput: boolean
  awaitReason: 'prompt' | 'idle' | null
}

function toSessionSummary(s: Session): SessionSummary {
  return {
    id: s.id,
    label: s.invocation.label,
    exited: s.exited,
    exitCode: s.exitCode,
    startedAt: s.startedAt,
    parentId: s.parentId,
    kind: s.kind,
    role: s.role,
    awaitingInput: s.awaitingInput,
    awaitReason: s.awaitReason,
  }
}

// Heuristic: an interactive agent that prints one of these and then stops
// emitting output is waiting on the developer (a permission prompt, a yes/no,
// a selection menu, …). We only flag it after output goes idle, so a spinner
// mid-think doesn't trip it.
const AWAIT_PATTERNS = [
  /❯\s*1\.\s/, // numbered selection menu (Claude Code permission prompt)
  /\bdo you want to\b/i,
  /\bproceed\?/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /press enter to (continue|confirm)/i,
  /\ballow this\b/i,
  /waiting for (your )?(input|response|confirmation)/i,
  /\b1\.\s*yes\b/i,
]
function looksAwaitingInput(buffer: string): boolean {
  // The current screen bottom is what matters — a prompt the TUI keeps redrawing
  // stays in the tail until it's answered.
  const clean = stripAnsi(buffer).slice(-900)
  return AWAIT_PATTERNS.some((re) => re.test(clean))
}

// A session is "long idle" when it hasn't emitted anything for this long — it
// has either finished and is waiting for the developer, or it stalled.
const LONG_IDLE_MS = 60_000

// A single periodic scan flips awaitingInput per session: a recognised prompt on
// screen, OR a long idle. Decoupled from output timing so the constantly-
// redrawing agent TUIs don't defeat the prompt check.
let scanTimer: ReturnType<typeof setInterval> | null = null
function ensureAwaitScanner() {
  if (scanTimer) return
  scanTimer = setInterval(() => {
    const now = Date.now()
    for (const s of sessions.values()) {
      if (s.exited) continue
      const prompt = looksAwaitingInput(s.buffer)
      const idle = now - s.lastOutputAt > LONG_IDLE_MS
      const reason = prompt ? 'prompt' : idle ? 'idle' : null
      const want = reason !== null
      if (want !== s.awaitingInput || reason !== s.awaitReason) {
        s.awaitingInput = want
        s.awaitReason = reason
        emitSessionEvent('session-updated', s)
      }
    }
  }, 1000)
  scanTimer.unref?.()
}

// ── Global session event stream ─────────────────────────────────────────────
// A tiny synchronous fan-out so main.ts can push "an agent was spawned /
// exited" to web clients without pty.ts importing main.ts (avoids a cycle).
export type SessionEvent = {
  type: 'session-created' | 'session-updated' | 'session-exited'
  session: SessionSummary
}

const eventListeners = new Set<(e: SessionEvent) => void>()

/** Subscribe to session lifecycle events. Returns an unsubscribe fn. */
export function onSessionEvent(cb: (e: SessionEvent) => void): () => void {
  eventListeners.add(cb)
  return () => eventListeners.delete(cb)
}

function emitSessionEvent(type: SessionEvent['type'], session: Session) {
  const payload: SessionEvent = { type, session: toSessionSummary(session) }
  for (const cb of eventListeners) cb(payload)
}

const ANSI_STRIP = /\x1B\[[0-?]*[ -/]*[@-~]/g
const DSR_CURSOR_POS = /\x1B\[6n/g
const DSR_STATUS = /\x1B\[5n/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_STRIP, '')
}

/**
 * Respond to Device Status Report (DSR) queries that the child writes to the
 * TTY. fzf sends `ESC [6n` (cursor-position request) and BLOCKS waiting for
 * `ESC [<row>;<col>R`. A real terminal emulator answers automatically; our
 * PTY master is a Node process, so we have to answer ourselves.
 *
 * We don't track a real cursor — just return (1,1). fzf only uses the value
 * to know where to render; in our headless context the visual position is
 * irrelevant, only the prompt text appearing in the stream matters.
 */
function answerDeviceStatusReports(pty: IPty, chunk: string) {
  const cursorMatches = chunk.match(DSR_CURSOR_POS)
  if (cursorMatches) {
    for (let i = 0; i < cursorMatches.length; i++) {
      pty.write('\x1B[1;1R')
    }
  }
  const statusMatches = chunk.match(DSR_STATUS)
  if (statusMatches) {
    for (let i = 0; i < statusMatches.length; i++) {
      pty.write('\x1B[0n')
    }
  }
}

function typeAnswer(pty: IPty, answer: string) {
  // Split the trailing carriage return / newline from the filter text and
  // pause briefly between them — fzf otherwise occasionally commits before
  // its filter render catches up, leaving the highlighted (default) item
  // selected instead of the typed match.
  const m = answer.match(/^([\s\S]*?)([\r\n]+)$/)
  if (!m) {
    pty.write(answer)
    return
  }
  const [, body, terminator] = m
  if (body) pty.write(body)
  setTimeout(() => pty.write(terminator), 120)
}

// Whitespace is dropped before comparing: the agent TUIs draw words with cursor
// moves rather than literal spaces, so the buffer cannot be trusted to contain them.
const squash = (s: string) => s.replace(/\s+/g, '')

/**
 * Answers scripted first-run dialogs so an agent doesn't sit idle on a default
 * such as Claude Code's "No, exit" trust screen. Each entry of
 * `invocation.prompts` is answered at most once, in any order, as soon as its
 * `match` text appears in the output. Answering clears the buffer so stale text
 * can't trigger the same entry again.
 */
function feedPromptIfMatched(session: Session) {
  const prompts: PromptAnswer[] = session.invocation.prompts
  for (let i = 0; i < prompts.length; i++) {
    if (session.promptsAnswered.has(i)) continue
    // Recompute per entry: the buffer was cleared by any earlier answer.
    const clean = squash(stripAnsi(session.buffer))
    if (!clean.includes(squash(prompts[i].match))) continue
    typeAnswer(session.pty, prompts[i].type)
    session.promptsAnswered.add(i)
    session.buffer = ''
  }
}

export type StartOptions = {
  cwd: string
  invocation: Invocation
  cols?: number
  rows?: number
  env?: Record<string, string>
  parentId?: string | null
  kind?: SessionKind
  role?: string | null
}

// Markers a Claude Code session sets on its own children. When the daemon was
// itself started from inside Claude Code they would leak into every agent it
// spawns: the agent then believes it is a child session (transcripts off) and
// can reach for the parent's messaging socket.
const SESSION_MARKERS =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(CHILD_SESSION|ENTRYPOINT|EXECPATH|SESSION_.*|MESSAGING_.*))$/

function inheritedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!SESSION_MARKERS.test(k)) env[k] = v
  return env
}

export function startSession(opts: StartOptions): Session {
  const id = randomUUID()
  const pty = spawn(opts.invocation.command, opts.invocation.args, {
    name: 'xterm-256color',
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 30,
    cwd: opts.cwd,
    env: {
      ...inheritedEnv(),
      ...(opts.env ?? {}),
      ...(opts.invocation.env ?? {}),
      TERM: 'xterm-256color',
    },
  })

  const session: Session = {
    id,
    invocation: opts.invocation,
    pty,
    output: '',
    buffer: '',
    promptsAnswered: new Set(),
    listeners: new Set(),
    exitListeners: new Set(),
    exited: false,
    exitCode: null,
    startedAt: Date.now(),
    parentId: opts.parentId ?? null,
    kind: opts.kind ?? 'command',
    role: opts.role ?? null,
    awaitingInput: false,
    awaitReason: null,
    lastOutputAt: Date.now(),
  }

  pty.onData((data) => {
    answerDeviceStatusReports(pty, data)
    session.lastOutputAt = Date.now()
    session.output += data
    session.buffer += data
    // Keep buffer bounded — only need recent text to match prompts.
    if (session.buffer.length > 8192) {
      session.buffer = session.buffer.slice(-4096)
    }
    feedPromptIfMatched(session)
    for (const cb of session.listeners) cb(data)
  })

  pty.onExit(({ exitCode, signal }) => {
    session.exited = true
    session.exitCode = exitCode
    session.awaitingInput = false
    session.awaitReason = null
    for (const cb of session.exitListeners) cb(exitCode, signal ?? 0)
    emitSessionEvent('session-exited', session)
  })

  sessions.set(id, session)
  ensureAwaitScanner()
  emitSessionEvent('session-created', session)
  return session
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id)
}

export function killSession(id: string, _signal: NodeJS.Signals = 'SIGINT') {
  const s = sessions.get(id)
  if (!s || s.exited) return false
  // Claude/codex TUIs run the terminal in raw mode and intercept a single
  // Ctrl-C ("press again to exit"), so a lone SIGINT won't stop them. Send a
  // double Ctrl-C for a graceful quit, then hard-kill if it's still alive.
  const ctrlC = () => {
    const cur = sessions.get(id)
    if (cur && !cur.exited) {
      try {
        cur.pty.write('\x03')
      } catch {
        /* pty gone */
      }
    }
  }
  ctrlC()
  setTimeout(ctrlC, 300)
  setTimeout(() => {
    const cur = sessions.get(id)
    if (cur && !cur.exited) {
      try {
        cur.pty.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }, 2500)
  return true
}

/**
 * Programmatically type into a running session's PTY — the same path the
 * websocket terminal uses (`pty.write`), exposed so the orchestrator (via the
 * send_input MCP tool) and resume flows can drive a session.
 *
 * Mirrors `promptOrchestrator`'s race fix: the body and the submitting CR are
 * written in separate ticks, because the agent TUIs (Claude Code, codex) treat
 * a trailing CR in the same chunk as a literal newline rather than "submit".
 */
export function writeToSession(
  id: string,
  text: string,
  opts: { enter?: boolean; bracketedPaste?: boolean } = {},
): boolean {
  const s = sessions.get(id)
  if (!s || s.exited) return false
  const enter = opts.enter ?? true
  const body = opts.bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text
  s.pty.write(body)
  if (enter) {
    setTimeout(() => {
      const cur = sessions.get(id)
      if (cur && !cur.exited) cur.pty.write('\r')
    }, 300)
  }
  return true
}

/**
 * Retire the sub-agents under `parentId` that are no longer doing anything,
 * so spawning a new one doesn't pile onto a screen of finished panes.
 *
 * Deliberately narrow about what counts as "unused": only a session that is
 * still alive AND has gone long-idle (no output for LONG_IDLE_MS — it finished
 * or stalled) is stopped. Two cases are left strictly alone:
 *  - `awaitReason: 'prompt'` — it asked a genuine question and is waiting on an
 *    answer. Killing it would throw away work the orchestrator asked for.
 *  - anything still emitting output — it's mid-task.
 * Already-exited sessions are left for `pruneExited` to age out, so the UI
 * doesn't lose panes it never got a removal event for.
 *
 * Returns the ids it stopped, for the caller to report.
 */
export function reapIdleSubagents(parentId: string): string[] {
  const reaped: string[] = []
  for (const s of sessionsByParent(parentId)) {
    if (s.awaitingInput && s.awaitReason === 'idle') {
      killSession(s.id)
      reaped.push(s.id)
    }
  }
  return reaped
}

/** Live (non-exited unless includeExited) sessions whose parent is `parentId`.
 * Used by park to gather the orchestrator's sub-agents. */
export function sessionsByParent(parentId: string, includeExited = false): Session[] {
  return Array.from(sessions.values()).filter(
    (s) => s.parentId === parentId && (includeExited || !s.exited),
  )
}

export function listSessions(): SessionSummary[] {
  return Array.from(sessions.values()).map(toSessionSummary)
}

/** What `waitForSession` treats as "done enough to hand back". */
export type WaitUntil = 'exit' | 'exit-or-input'
export type WaitOutcome = 'exited' | 'awaiting-input' | 'timeout'

// Capped below Node's 300s server.requestTimeout so a long wait can't be cut
// off mid-flight by the HTTP layer. A caller that times out just calls again.
const MAX_WAIT_MS = 180_000

/**
 * Resolve when a session finishes — or blocks on input — instead of making the
 * caller poll for it.
 *
 * The orchestrator used to spin `read_session` in a loop until `exited:true`,
 * which costs one inference turn per iteration and re-reads the whole
 * accumulated output each time. Everything that loop was watching for is
 * already computed here: `onExit` sets `exited`, and the periodic scanner
 * (`ensureAwaitScanner`) sets `awaitingInput`. Both emit session events, so we
 * can just listen and settle once.
 *
 * Returns null if there is no such session.
 */
export function waitForSession(
  id: string,
  opts: { timeoutMs?: number; until?: WaitUntil } = {},
): Promise<WaitOutcome> | null {
  const session = sessions.get(id)
  if (!session) return null

  const until = opts.until ?? 'exit-or-input'
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 120_000, 1_000), MAX_WAIT_MS)

  const settled = (s: Session): WaitOutcome | null => {
    if (s.exited) return 'exited'
    if (until === 'exit-or-input' && s.awaitingInput) return 'awaiting-input'
    return null
  }

  // Already there — don't wait on an event that has come and gone.
  const immediate = settled(session)
  if (immediate) return Promise.resolve(immediate)

  return new Promise<WaitOutcome>((resolve) => {
    let done = false
    const finish = (outcome: WaitOutcome) => {
      if (done) return
      done = true
      clearTimeout(timer)
      unsubscribe()
      resolve(outcome)
    }
    const unsubscribe = onSessionEvent((e) => {
      if (e.session.id !== id) return
      const cur = sessions.get(id)
      // Pruned out from under us — treat as finished rather than hanging.
      if (!cur) return finish('exited')
      const outcome = settled(cur)
      if (outcome) finish(outcome)
    })
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    timer.unref?.()
  })
}

export function pruneExited(maxAgeMs = 60 * 60 * 1000) {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (s.exited && now - s.startedAt > maxAgeMs) sessions.delete(id)
  }
}
