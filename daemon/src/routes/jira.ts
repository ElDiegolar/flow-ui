/**
 * Jira: board discovery, selection and sync (run by the daemon over the hub's
 * one Atlassian connection), the legacy bulk import, and the jira_call proxy
 * the orchestrator's Jira tools go through.
 */
import type { FastifyInstance } from 'fastify'
import { publish } from '../common/bus.ts'
import { callTool, listTools, serverStatus } from '../integrations/hub.ts'
import { discoverBoards, jiraSites, syncBoard } from '../integrations/jiraBoard.ts'
import { getJira, selectBoard, setBoards } from '../jira.ts'
import { getSettings } from '../settings.ts'
import { importJiraIssues, listTasks, type JiraIssueInput } from '../tasks.ts'

/**
 * Atlassian tools that only read. Everything else — create, edit, transition,
 * comment, worklog, link, and the Confluence writes — is a write, refused while
 * the read-only setting is on. An allowlist, so a tool Atlassian adds later is
 * a write until someone decides otherwise.
 */
export function isReadTool(tool: string): boolean {
  return /^(get|search|lookup|fetch)/.test(tool) || tool === 'atlassianUserInfo'
}

export function registerJiraRoutes(scope: FastifyInstance) {
  const fail = (reply: { code: (n: number) => unknown }, e: unknown, code = 502) => {
    reply.code(code)
    return { error: (e as Error).message }
  }

  scope.get('/api/jira', async () => ({ ...getJira(), connection: serverStatus('atlassian') }))

  // Kept for the orchestrator's jira_set_boards; the UI uses /discover now.
  scope.put<{ Body: { boards?: unknown[] } }>('/api/jira/boards', async (req) =>
    setBoards(Array.isArray(req.body?.boards) ? (req.body.boards as []) : []),
  )

  // Picking a board re-syncs straight away, so the list shows that board.
  scope.put<{ Body: { id?: string | null } }>('/api/jira/select', async (req) => {
    const state = selectBoard(req.body?.id ?? null)
    publish({ type: 'tasks-changed', reason: 'board-selected' })
    if (state.selectedId && serverStatus('atlassian').state === 'connected')
      void syncBoard('board-selected').catch(() => {})
    return state
  })

  scope.post('/api/jira/discover', async (_req, reply) => {
    try {
      return await discoverBoards()
    } catch (e) {
      return fail(reply, e)
    }
  })

  scope.post('/api/jira/sync', async (_req, reply) => {
    try {
      return { result: await syncBoard('manual'), jira: getJira() }
    } catch (e) {
      return fail(reply, e)
    }
  })

  // What the orchestrator needs to make a call: is it connected, and the cloudIds.
  scope.get('/api/jira/status', async () => {
    const connection = serverStatus('atlassian')
    const jira = getJira()
    const board = jira.boards.find((b) => b.id === jira.selectedId) ?? null
    let sites: Awaited<ReturnType<typeof jiraSites>> | { error: string } | null = null
    if (connection.state === 'connected') {
      try {
        sites = await jiraSites()
      } catch (e) {
        sites = { error: (e as Error).message }
      }
    }
    return {
      connected: connection.state === 'connected',
      state: connection.state,
      detail: connection.detail,
      readOnly: getSettings().jiraReadOnly,
      sites,
      selectedBoard: board,
      lastSync: jira.lastSync,
    }
  })

  scope.get('/api/jira/tools', async (_req, reply) => {
    try {
      const readOnly = getSettings().jiraReadOnly
      const tools = await listTools('atlassian')
      return {
        readOnly,
        tools: tools.map((t) => ({ ...t, write: !isReadTool(t.name) })),
      }
    } catch (e) {
      return fail(reply, e, 503)
    }
  })

  scope.post<{ Body: { tool?: string; args?: Record<string, unknown> } }>(
    '/api/jira/call',
    async (req, reply) => {
      const tool = req.body?.tool
      if (!tool) {
        reply.code(400)
        return { error: 'tool required' }
      }
      // Enforced here, not by the agent's own tool gating: the orchestrator
      // reaches Atlassian only through this route, whichever engine it is.
      if (!isReadTool(tool) && getSettings().jiraReadOnly) {
        reply.code(403)
        return {
          error:
            `${tool} changes Jira, and Jira is read-only. The developer can turn read-only ` +
            'off on the Tasks tab if they want you to make this change.',
        }
      }
      try {
        return await callTool('atlassian', tool, req.body?.args ?? {})
      } catch (e) {
        return fail(reply, e, 503)
      }
    },
  )

  // Bulk import, kept for the jira_import_issues tool. The board sync
  // supersedes it for the selected board.
  scope.post<{
    Body: { issues?: JiraIssueInput[]; category?: string; repo?: string }
  }>('/api/jira/import', async (req, reply) => {
    const { issues, category, repo } = req.body ?? {}
    if (!Array.isArray(issues)) {
      reply.code(400)
      return { error: 'issues must be an array' }
    }
    try {
      const result = importJiraIssues(issues, { category, repo })
      publish({ type: 'tasks-changed', reason: 'import' })
      return {
        created: result.created.length,
        skipped: result.skipped,
        invalid: result.invalid,
        tasks: listTasks(),
      }
    } catch (e) {
      reply.code(400)
      return { error: (e as Error).message }
    }
  })
}
