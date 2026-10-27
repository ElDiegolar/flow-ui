/**
 * Jira board discovery state. The orchestrator (via the Atlassian MCP) figures
 * out which boards/projects the user has assigned work in — possibly across
 * several Atlassian sites/orgs — and reports them with the jira_set_boards tool.
 * The user then selects the relevant board, and imports are scoped to it.
 *
 * Persisted next to tasks.json under the (isolated) FLOW_HOME.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { HOME_FILES } from './common/home.ts'

const JIRA_FILE = HOME_FILES.jira

export type Board = {
  /** Stable id: `<cloudId|site>:<key>`. */
  id: string
  /** Project/board key, e.g. "STL". */
  key: string
  name: string
  /** Atlassian site host (e.g. acme.atlassian.net) — distinguishes orgs. */
  site: string | null
  cloudId: string | null
  url: string | null
  /** How many assigned, not-done issues the user has there (best-effort). */
  issueCount: number | null
}

/** The outcome of the last board sync, for the Tasks tab's status line. */
export type SyncRecord = {
  at: number
  ok: boolean
  error: string | null
  reason: string
  open?: number
  created?: number
  updated?: number
  cleared?: number
  flagged?: number
}

export type JiraState = {
  boards: Board[]
  selectedId: string | null
  updatedAt: number
  lastSync: SyncRecord | null
}

const EMPTY: JiraState = { boards: [], selectedId: null, updatedAt: 0, lastSync: null }

function read(): JiraState {
  try {
    return { ...EMPTY, ...JSON.parse(readFileSync(JIRA_FILE, 'utf8')) }
  } catch {
    return { ...EMPTY }
  }
}

function write(state: JiraState) {
  mkdirSync(path.dirname(JIRA_FILE), { recursive: true })
  writeFileSync(JIRA_FILE, JSON.stringify(state, null, 2), { mode: 0o600 })
}

export function getJira(): JiraState {
  return read()
}

export function getSelectedBoard(): Board | null {
  const s = read()
  return s.boards.find((b) => b.id === s.selectedId) ?? null
}

type BoardInput = {
  key?: string
  name?: string
  site?: string
  cloudId?: string
  url?: string
  issueCount?: number
}

export function setBoards(input: BoardInput[]): JiraState {
  const prev = read()
  const boards: Board[] = (input ?? [])
    .filter((b) => b.key || b.name)
    .map((b) => {
      const key = (b.key ?? b.name ?? '').trim()
      const id = `${b.cloudId ?? b.site ?? ''}:${key}`
      return {
        id,
        key,
        name: (b.name ?? key).trim(),
        site: b.site?.trim() || null,
        cloudId: b.cloudId?.trim() || null,
        url: b.url?.trim() || null,
        issueCount: typeof b.issueCount === 'number' ? b.issueCount : null,
      }
    })
  // Keep the prior selection if it still exists; else default to the first board.
  const selectedId =
    prev.selectedId && boards.some((b) => b.id === prev.selectedId)
      ? prev.selectedId
      : (boards[0]?.id ?? null)
  const state: JiraState = { boards, selectedId, updatedAt: Date.now(), lastSync: prev.lastSync }
  write(state)
  return state
}

export function selectBoard(id: string | null): JiraState {
  const state = read()
  state.selectedId = id && state.boards.some((b) => b.id === id) ? id : null
  write(state)
  return state
}

export function recordSync(rec: SyncRecord): void {
  const state = read()
  state.lastSync = rec
  write(state)
}
