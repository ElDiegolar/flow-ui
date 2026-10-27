/**
 * A session's terminal output as an agent should read it.
 *
 * `session.output` is the raw PTY stream: colour codes, cursor moves, and a TUI
 * (claude/codex) redrawing its spinner and status bar many times a second. Fed
 * to the orchestrator as-is through read_session / wait_for_session, a
 * one-word reply cost ~6.6k characters, and every call re-sent the whole
 * history, so a long sub-agent run grew the orchestrator's context
 * quadratically.
 *
 * This renders the stream through a headless xterm (the same emulator the UI
 * uses), so redraws collapse into the text a person would see. It drops TUI
 * chrome that carries no information and returns only the lines added since
 * the reader's last cursor, capped to a tail. The UI keeps the raw stream
 * (/replay without `view=text`); this is only for agent readers.
 */
import xterm from '@xterm/headless'
import type { Session } from './pty.ts'

/** Most text returned per read. The tail is what an agent acts on. */
const MAX_CHARS = 6000

// Lines that are pure TUI decoration: spinner frames, box/logo glyphs, rules.
const DECORATION = /^[\s✻✽✶✢·*…─━═│┃╭╮╰╯┌┐└┘▐▛▜▝▘▗▖█▀▄◐◑◒◓⏵❯>-]*$/u
// The claude/codex logo banner (its version/cwd lines add nothing either).
const BANNER = /^\s*[▐▛▜▝▘▗▖█▀▄]{2,}/u
// Status-bar hints the agent never needs to read.
const CHROME =
  /esc to interrupt|shift\+tab to cycle|\? for shortcuts|ctrl\+[a-z] to |Transcript saving is off|\/effort$/i

export type SessionText = {
  /** Readable text since the cursor (tail-capped). */
  text: string
  /** Pass back as `since` next time to get only what is new. */
  cursor: number
  /** Lines dropped from the front to stay under the cap. */
  omittedLines: number
}

async function renderLines(s: Session): Promise<{ lines: string[]; rows: number }> {
  const cols = s.pty.cols || 120
  const rows = s.pty.rows || 30
  const term = new xterm.Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true })
  await new Promise<void>((resolve) => term.write(s.output, resolve))
  const buf = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  term.dispose()
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return { lines, rows }
}

export async function sessionText(s: Session, since = 0): Promise<SessionText> {
  const { lines, rows } = await renderLines(s)
  // Re-send the live screen area: a TUI redraws it in place, so lines the
  // reader already saw there may have changed. Scrollback above it is final.
  const from = Math.max(0, Math.min(since, lines.length) - rows)
  const kept: string[] = []
  for (const line of lines.slice(from)) {
    const l = line.trimEnd()
    if (!l.trim() || DECORATION.test(l) || BANNER.test(l) || CHROME.test(l)) continue
    if (kept[kept.length - 1] === l) continue
    kept.push(l)
  }
  // Keep whole lines from the end until the cap.
  let start = kept.length
  let size = 0
  while (start > 0 && size + kept[start - 1].length + 1 <= MAX_CHARS)
    size += kept[--start].length + 1
  if (start === kept.length && kept.length) start-- // one huge line: keep its tail
  const text = kept.slice(start).join('\n').slice(-MAX_CHARS)
  return { text, cursor: lines.length, omittedLines: start }
}
