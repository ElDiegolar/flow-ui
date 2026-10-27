/**
 * Jira board discovery + sync, run by the daemon itself over the hub's single
 * Atlassian connection.
 *
 * This used to be a prompt: the Tasks tab typed "discover my boards" / "import
 * my board" into the orchestrator and polled until the task count stopped
 * moving. That needed a running orchestrator, cost a model turn per refresh,
 * could only ever ADD tasks (so work finished in Jira stayed on the board, and
 * stayed parked, forever), and gave up after ~80s. None of it needs judgement:
 * it is one JQL query and a set difference, so it runs here, on a timer.
 */
import { publish } from '../common/bus.ts'
import { getSelectedBoard, recordSync, setBoards, type Board } from '../jira.ts'
import { orchestratorId, orchestratorStatus } from '../orchestrator/index.ts'
import { getSettings } from '../settings.ts'
import { reconcileBoard, type BoardIssue, type ReconcileResult, type Task } from '../tasks.ts'
import { callTool, serverStatus, toolJson } from './hub.ts'

export type JiraSite = { cloudId: string; url: string; name: string }

type Resource = { id?: string; url?: string; name?: string; scopes?: string[] }

/**
 * Sites this login can read Jira on. An Atlassian OAuth grant is per product:
 * a login consented for Confluence only lists the site but every Jira call
 * 404s — so filter on the granted scopes and say so, rather than reporting
 * "no boards" for what is really a consent problem.
 */
/** The last jiraSites answer — lets Setup say "connected, but no Jira" without a call per poll. */
let lastAccess: { at: number; sites: number; withoutJira: string[] } | null = null
export function lastJiraAccess() {
  return lastAccess
}

export async function jiraSites(): Promise<{ sites: JiraSite[]; withoutJira: string[] }> {
  const res = toolJson(await callTool('atlassian', 'getAccessibleAtlassianResources', {}))
  const list = Array.isArray(res) ? (res as Resource[]) : []
  const sites: JiraSite[] = []
  const withoutJira: string[] = []
  for (const r of list) {
    if (!r.id || !r.url) continue
    const jira = !r.scopes || r.scopes.some((s) => s.includes('jira'))
    if (jira) sites.push({ cloudId: r.id, url: r.url, name: r.name ?? r.url })
    else withoutJira.push(r.url)
  }
  lastAccess = { at: Date.now(), sites: sites.length, withoutJira }
  return { sites, withoutJira }
}

type RawIssue = {
  key?: string
  fields?: {
    summary?: string
    description?: unknown
    status?: { name?: string }
    project?: { key?: string; name?: string }
  }
}

/** Page through a JQL search to the end. `cap` stops a runaway query; hitting
 * it is reported, because a truncated set must never drive the reconcile. */
async function searchAll(
  cloudId: string,
  jql: string,
  cap = 1000,
): Promise<{ issues: RawIssue[]; complete: boolean }> {
  const issues: RawIssue[] = []
  let nextPageToken: string | undefined
  for (;;) {
    const page = toolJson(
      await callTool('atlassian', 'searchJiraIssuesUsingJql', {
        cloudId,
        jql,
        maxResults: 100,
        fields: ['summary', 'description', 'status', 'project'],
        responseContentFormat: 'markdown',
        ...(nextPageToken ? { nextPageToken } : {}),
      }),
    ) as { issues?: RawIssue[]; nextPageToken?: string; isLast?: boolean }
    issues.push(...(page.issues ?? []))
    nextPageToken = page.nextPageToken
    if (page.isLast !== false || !nextPageToken) return { issues, complete: true }
    if (issues.length >= cap) return { issues, complete: false }
  }
}

const MINE_OPEN = 'assignee = currentUser() AND statusCategory != Done'

/** Find every project the developer has open, assigned work in, across sites. */
export async function discoverBoards() {
  const { sites, withoutJira } = await jiraSites()
  if (!sites.length) {
    throw new Error(
      withoutJira.length
        ? `This Atlassian login has no Jira access (only ${withoutJira.join(', ')} for other ` +
            'products). In Setup, Reset Atlassian and Connect again — and grant Jira on the ' +
            'consent screen.'
        : 'This Atlassian login can see no sites. Reset and Connect again in Setup.',
    )
  }
  const boards: Array<{
    key: string
    name: string
    site: string
    cloudId: string
    url: string
    issueCount: number
  }> = []
  for (const site of sites) {
    const { issues } = await searchAll(site.cloudId, `${MINE_OPEN} ORDER BY updated DESC`)
    const byProject = new Map<string, { name: string; count: number }>()
    for (const i of issues) {
      const key = i.fields?.project?.key
      if (!key) continue
      const p = byProject.get(key) ?? { name: i.fields?.project?.name ?? key, count: 0 }
      p.count++
      byProject.set(key, p)
    }
    for (const [key, p] of byProject)
      boards.push({
        key,
        name: p.name,
        site: new URL(site.url).host,
        cloudId: site.cloudId,
        url: `${site.url}/jira/software/projects/${key}`,
        issueCount: p.count,
      })
  }
  const state = setBoards(boards)
  publish({ type: 'tasks-changed', reason: 'boards-discovered' })
  return state
}

function descriptionText(d: unknown): string {
  if (typeof d === 'string') return d.trim()
  return '' // ADF — markdown was requested; anything else is not worth rendering raw
}

function normalise(i: RawIssue, siteUrl: string | null): BoardIssue | null {
  if (!i.key) return null
  return {
    key: i.key,
    summary: i.fields?.summary?.trim() || i.key,
    description: descriptionText(i.fields?.description),
    url: siteUrl ? `${siteUrl}/browse/${i.key}` : null,
    status: i.fields?.status?.name ?? null,
  }
}

/** A task is live when the running orchestrator is working on it. */
function isLive(t: Task): boolean {
  const oid = orchestratorId()
  return !!oid && orchestratorStatus().running && t.sessionIds.includes(oid)
}

export type SyncResult = ReconcileResult & { board: string; open: number; at: number }

let syncing: Promise<SyncResult> | null = null

/** Sync the selected board. Concurrent callers share the one in-flight run. */
export function syncBoard(reason = 'manual'): Promise<SyncResult> {
  if (!syncing)
    syncing = runSync(reason).finally(() => {
      syncing = null
    })
  return syncing
}

async function runSync(reason: string): Promise<SyncResult> {
  const board: Board | null = getSelectedBoard()
  try {
    if (!board) throw new Error('No Jira board selected — discover boards and pick one first.')
    if (!board.cloudId) throw new Error(`Board ${board.key} has no cloudId — rediscover boards.`)
    const siteUrl = board.site ? `https://${board.site}` : null
    const { issues, complete } = await searchAll(
      board.cloudId,
      `project = "${board.key}" AND ${MINE_OPEN} ORDER BY updated DESC`,
    )
    if (!complete)
      throw new Error(`More than 1000 open issues on ${board.key} — refusing a partial sync.`)
    const open = issues.map((i) => normalise(i, siteUrl)).filter((i): i is BoardIssue => !!i)
    const result = reconcileBoard(board, open, isLive)
    const at = Date.now()
    recordSync({ at, ok: true, error: null, reason, ...countsOf(result, open.length) })
    publish({ type: 'tasks-changed', reason: `sync:${reason}` })
    return { ...result, board: board.key, open: open.length, at }
  } catch (e) {
    recordSync({ at: Date.now(), ok: false, error: (e as Error).message, reason })
    publish({ type: 'tasks-changed', reason: 'sync-failed' })
    throw e
  }
}

function countsOf(r: ReconcileResult, open: number) {
  return {
    open,
    created: r.created,
    updated: r.updated,
    cleared: r.cleared.length,
    flagged: r.flagged.length,
  }
}

/** Background sync on the configured interval, only while Jira is connected —
 * a sync must never be what triggers a connection (and so a login window). */
export function startBoardSyncTimer() {
  let last = 0
  const t = setInterval(() => {
    const minutes = getSettings().jiraSyncMinutes
    if (!minutes || Date.now() - last < minutes * 60_000) return
    if (serverStatus('atlassian').state !== 'connected' || !getSelectedBoard()) return
    last = Date.now()
    syncBoard('timer').catch(() => {
      /* recorded in jira.json and shown on the Tasks tab */
    })
  }, 30_000)
  t.unref?.()
}
