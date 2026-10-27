/**
 * Task intake for the agentic dev-team flow.
 *
 * A task is a unit of work the user wants done: typed by hand, or pulled in from
 * a pasted Jira link (link + description only — no Jira credentials are wired).
 * Tasks are pinned to a project/repo so "Start work" can hand the orchestrator
 * the right context. Persistence mirrors visual.ts's verdicts.json: a single
 * JSON file under the (isolated) FLOW_HOME, no DB.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { HOME_FILES } from './common/home.ts'

const TASKS_FILE = HOME_FILES.tasks

export type TaskStatus = 'todo' | 'in_progress' | 'parked' | 'review' | 'done'
export const TASK_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'parked', 'review', 'done']

export type Task = {
  id: string
  title: string
  description: string
  source: 'manual' | 'jira'
  jiraUrl: string | null
  jiraKey: string | null
  category: string | null
  repo: string | null
  status: TaskStatus
  /** Sessions associated with this task (the orchestrator + its subagents). */
  sessionIds: string[]
  createdAt: number
  updatedAt: number
  /** The Jira board (jira.ts Board.id) a synced task came from. */
  boardId?: string | null
  /** Jira's own status name at the last sync, e.g. "In Review". */
  jiraStatus?: string | null
  /**
   * Done in Jira / gone from the board, but it still has a live orchestrator,
   * so it is flagged rather than cleared out from under the running agents.
   * The first sync after the work stops archives it.
   */
  jiraGone?: boolean
  /** Hidden from the board. Set by a sync when the issue is done or gone. */
  archivedAt?: number | null
  archivedReason?: string | null
}

function readTasks(): Task[] {
  try {
    const raw = JSON.parse(readFileSync(TASKS_FILE, 'utf8'))
    return Array.isArray(raw) ? (raw as Task[]) : []
  } catch {
    return []
  }
}

function writeTasks(tasks: Task[]) {
  mkdirSync(path.dirname(TASKS_FILE), { recursive: true })
  writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), { mode: 0o600 })
}

/** Newest first. Archived tasks (done/gone in Jira) are left out unless asked for. */
export function listTasks(opts: { includeArchived?: boolean } = {}): Task[] {
  return readTasks()
    .filter((t) => opts.includeArchived || !t.archivedAt)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export function getTask(id: string): Task | undefined {
  return readTasks().find((t) => t.id === id)
}

/**
 * Pull the issue key out of a Jira URL or bare key. Handles the common
 * `.../browse/ABC-123` and `.../jira/.../issues/ABC-123` shapes, plus a raw
 * `ABC-123`. Returns null if nothing key-shaped is found.
 */
export function parseJiraKey(input: string): string | null {
  const m = input.match(/([A-Z][A-Z0-9]+-\d+)/)
  return m ? m[1] : null
}

export type CreateTaskInput = {
  title?: string
  description?: string
  jiraUrl?: string
  category?: string
  repo?: string
}

/** Build a Task from intake input. Shared by createTask and the Jira importer
 * so a hand-typed task and an imported one have exactly the same shape. */
function makeTask(input: CreateTaskInput, explicitKey?: string | null): Task {
  const jiraUrl = input.jiraUrl?.trim() || null
  const jiraKey = explicitKey ?? (jiraUrl ? parseJiraKey(jiraUrl) : null)
  // A pasted Jira link can stand in for the title until the user edits it.
  const title = input.title?.trim() || (jiraKey ? jiraKey : '')
  if (!title) throw new Error('title (or a Jira link) is required')
  const now = Date.now()
  return {
    id: randomUUID(),
    title,
    description: input.description?.trim() ?? '',
    source: jiraUrl || jiraKey ? 'jira' : 'manual',
    jiraUrl,
    jiraKey,
    category: input.category?.trim() || null,
    repo: input.repo?.trim() || null,
    status: 'todo',
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function createTask(input: CreateTaskInput): Task {
  const task = makeTask(input)
  const tasks = readTasks()
  tasks.push(task)
  writeTasks(tasks)
  return task
}

/** One Jira issue as handed over by the caller that queried Jira. Field names
 * are loose because they come straight off an Atlassian API response. */
export type JiraIssueInput = {
  key?: string
  summary?: string
  title?: string
  description?: string
  url?: string
  jiraUrl?: string
  category?: string
  repo?: string
}

export type JiraImportResult = {
  created: Task[]
  /** Issues that already had a task, by Jira key. */
  skipped: string[]
  /** Entries with neither a usable key nor a title. */
  invalid: number
}

/**
 * Upsert a batch of Jira issues into the task board, deduped by Jira key.
 *
 * This replaces a prose instruction to the orchestrator ("call task_list, then
 * task_create for each issue that does not already have one, skip duplicates").
 * That loop is fully determined by the input, so running it here makes it
 * atomic (one file write), exhaustive (no issue quietly dropped mid-loop), and
 * actually dedupe-safe — the model was only ever *asked* not to duplicate.
 */
export function importJiraIssues(
  issues: JiraIssueInput[],
  defaults: { category?: string; repo?: string } = {},
): JiraImportResult {
  const tasks = readTasks()
  const seen = new Set(tasks.map((t) => t.jiraKey).filter((k): k is string => Boolean(k)))
  const created: Task[] = []
  const skipped: string[] = []
  let invalid = 0

  for (const issue of issues ?? []) {
    const url = (issue.url ?? issue.jiraUrl)?.trim() || undefined
    const key = issue.key?.trim() || (url ? parseJiraKey(url) : null)
    const title = (issue.summary ?? issue.title)?.trim() || key || ''
    if (!title) {
      invalid++
      continue
    }
    // Dedupe against the board AND within this batch.
    if (key && seen.has(key)) {
      skipped.push(key)
      continue
    }
    const task = makeTask(
      {
        title,
        description: issue.description,
        jiraUrl: url,
        category: issue.category ?? defaults.category,
        repo: issue.repo ?? defaults.repo,
      },
      key,
    )
    if (key) seen.add(key)
    tasks.push(task)
    created.push(task)
  }

  if (created.length) writeTasks(tasks)
  return { created, skipped, invalid }
}

export type UpdateTaskPatch = Partial<
  Pick<Task, 'title' | 'description' | 'category' | 'repo' | 'status'>
> & {
  /** Session id to append to sessionIds (deduped). */
  addSessionId?: string
  /** Replace the whole sessionIds list (used by resume to remap old→new ids). */
  setSessionIds?: string[]
}

export function updateTask(id: string, patch: UpdateTaskPatch): Task | undefined {
  const tasks = readTasks()
  const t = tasks.find((x) => x.id === id)
  if (!t) return undefined
  if (patch.title !== undefined) t.title = patch.title.trim()
  if (patch.description !== undefined) t.description = patch.description
  if (patch.category !== undefined) t.category = patch.category || null
  if (patch.repo !== undefined) t.repo = patch.repo || null
  if (patch.status !== undefined) {
    if (!TASK_STATUSES.includes(patch.status)) throw new Error(`bad status: ${patch.status}`)
    t.status = patch.status
  }
  if (patch.setSessionIds !== undefined) {
    t.sessionIds = [...new Set(patch.setSessionIds)]
  }
  if (patch.addSessionId && !t.sessionIds.includes(patch.addSessionId)) {
    t.sessionIds.push(patch.addSessionId)
  }
  t.updatedAt = Date.now()
  writeTasks(tasks)
  return t
}

export function deleteTask(id: string): boolean {
  const tasks = readTasks()
  const next = tasks.filter((t) => t.id !== id)
  if (next.length === tasks.length) return false
  writeTasks(next)
  return true
}

/** One issue as the board sync normalises it from Jira's /search/jql. */
export type BoardIssue = {
  key: string
  summary: string
  description: string
  url: string | null
  status: string | null
}

export type ReconcileResult = {
  created: number
  updated: number
  /** Archived: done in Jira, or no longer on the board. */
  cleared: string[]
  /** Gone from Jira but still running — flagged, archived once it stops. */
  flagged: string[]
  /** Came back onto the board after being cleared. */
  restored: string[]
}

/** Does this task belong to that board? A task imported before boards were
 * tracked has no boardId, so fall back to its key's project prefix. */
function onBoard(t: Task, board: { id: string; key: string }): boolean {
  if (t.source !== 'jira' || !t.jiraKey) return false
  if (t.boardId) return t.boardId === board.id
  return t.jiraKey.startsWith(`${board.key}-`)
}

/**
 * Make the task list match the board: the COMPLETE set of the developer's open
 * issues on it (the caller must have paged through every result — a partial
 * page here would clear real work). New issues become tasks, known ones get
 * their title/status refreshed, and any task whose issue is no longer in the
 * set — done, reassigned, moved off the board — is archived, parked or not.
 * `isLive` guards the one exception: a task an orchestrator is working on
 * right now is flagged instead, so the agents aren't orphaned mid-run.
 */
export function reconcileBoard(
  board: { id: string; key: string },
  issues: BoardIssue[],
  isLive: (t: Task) => boolean,
): ReconcileResult {
  const tasks = readTasks()
  const byKey = new Map(tasks.filter((t) => t.jiraKey).map((t) => [t.jiraKey as string, t]))
  const now = Date.now()
  const result: ReconcileResult = { created: 0, updated: 0, cleared: [], flagged: [], restored: [] }
  const open = new Set<string>()

  for (const issue of issues) {
    open.add(issue.key)
    const t = byKey.get(issue.key)
    if (!t) {
      const task = makeTask(
        {
          title: issue.summary || issue.key,
          description: issue.description,
          jiraUrl: issue.url ?? undefined,
        },
        issue.key,
      )
      task.boardId = board.id
      task.jiraStatus = issue.status
      tasks.push(task)
      byKey.set(issue.key, task)
      result.created++
      continue
    }
    let changed = false
    const set = <K extends keyof Task>(k: K, v: Task[K]) => {
      if (t[k] !== v) {
        t[k] = v
        changed = true
      }
    }
    if (t.archivedAt) {
      t.archivedAt = null
      t.archivedReason = null
      if (t.status === 'done') t.status = 'todo'
      result.restored.push(issue.key)
      changed = true
    }
    // Title/description follow Jira, which is the source of truth for them;
    // category/repo/status are the developer's and are never overwritten.
    if (issue.summary) set('title', issue.summary)
    if (issue.description) set('description', issue.description)
    set('jiraStatus', issue.status)
    set('boardId', board.id)
    if (!t.jiraUrl && issue.url) set('jiraUrl', issue.url)
    if (t.jiraGone) set('jiraGone', false)
    if (changed) {
      t.updatedAt = now
      result.updated++
    }
  }

  for (const t of tasks) {
    if (t.archivedAt || !onBoard(t, board) || open.has(t.jiraKey as string)) continue
    if (isLive(t)) {
      if (!t.jiraGone) {
        t.jiraGone = true
        t.updatedAt = now
      }
      result.flagged.push(t.jiraKey as string)
      continue
    }
    t.archivedAt = now
    t.archivedReason = 'Done in Jira, or no longer on the board'
    t.jiraGone = false
    t.updatedAt = now
    result.cleared.push(t.jiraKey as string)
  }

  if (result.created || result.updated || result.cleared.length || result.flagged.length)
    writeTasks(tasks)
  return result
}
