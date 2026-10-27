/**
 * Task intake, and the park/resume lifecycle that lets one be set aside.
 */
import type { FastifyInstance } from 'fastify'
import { parkActiveTask, parkTask, parkedManifest, readParkedHistory, resumeTask } from '../park.ts'
import {
  orchestratorId,
  orchestratorStatus,
  promptOrchestrator,
  restartOrchestrator,
} from '../orchestrator/index.ts'
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  updateTask,
  type TaskStatus,
} from '../tasks.ts'
import type { RouteContext } from './context.ts'

// After a resume, maps a task's restored session ids old->new so the history
// route can serve the right saved log for a freshly-spawned session. In memory:
// survives until the next park/restart, which is the window the UI needs it.
const resumeMaps = new Map<string, Record<string, string>>()

export function registerTaskRoutes(scope: FastifyInstance, ctx: RouteContext) {
  const { token, daemonUrl: DAEMON_URL } = ctx
  // ── Tasks: the agentic dev-team intake ─────────────────────────────────────
  // Archived tasks (done or gone in Jira) only on request — the board shows
  // what is open on it now.
  scope.get<{ Querystring: { archived?: string } }>('/api/tasks', async (req) => ({
    tasks: listTasks({ includeArchived: req.query.archived === '1' }),
  }))

  scope.post<{
    Body: {
      title?: string
      description?: string
      jiraUrl?: string
      category?: string
      repo?: string
    }
  }>('/api/tasks', async (req, reply) => {
    try {
      return { task: createTask(req.body ?? {}) }
    } catch (e) {
      reply.code(400)
      return { error: (e as Error).message }
    }
  })

  scope.patch<{
    Params: { id: string }
    Body: {
      title?: string
      description?: string
      category?: string
      repo?: string
      status?: TaskStatus
    }
  }>('/api/tasks/:id', async (req, reply) => {
    try {
      const task = updateTask(req.params.id, req.body ?? {})
      if (!task) {
        reply.code(404)
        return { error: 'task not found' }
      }
      return { task }
    } catch (e) {
      reply.code(400)
      return { error: (e as Error).message }
    }
  })

  scope.delete<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    if (!deleteTask(req.params.id)) {
      reply.code(404)
      return { error: 'task not found' }
    }
    return { ok: true }
  })

  // Start work: hand the task to the orchestrator — pin it to the task's project
  // and seed the task brief. The orchestrator then delegates the actual work to a
  // sub-agent per its brief.
  scope.post<{ Params: { id: string } }>('/api/tasks/:id/start', async (req, reply) => {
    const task = getTask(req.params.id)
    if (!task) {
      reply.code(404)
      return { error: 'task not found' }
    }
    const pin =
      task.category && task.repo ? { category: task.category, repo: task.repo } : undefined
    const brief =
      `New task${task.jiraKey ? ` [${task.jiraKey}]` : ''}: ${task.title}.` +
      (task.description ? ` Details: ${task.description}.` : '') +
      (pin ? ` Project: ${pin.category}/${pin.repo}.` : '') +
      (task.jiraUrl ? ` Jira: ${task.jiraUrl}.` : '') +
      ` Per your delegation policy, spin up a sub-agent with run_agent on this repo to do` +
      ` the work — you coordinate and report. Confirm the plan, then delegate.`

    // Only add context to the SAME task's live orchestrator. If the running
    // orchestrator belongs to another task (or was just SIGINT'd by a park),
    // restart cleanly — restartOrchestrator detaches the old session first, so
    // we never type the brief into a dying process (which crashed the terminal).
    const oid = orchestratorId()
    const sameTaskLive =
      orchestratorStatus().running && oid !== null && task.sessionIds.includes(oid)
    if (sameTaskLive) {
      promptOrchestrator(brief)
    } else {
      // Switching away from a live task: PARK it first. Restarting the
      // orchestrator without parking used to discard the outgoing task's
      // scrollback since the last snapshot and leave its sub-agents running
      // orphaned, while the task itself stayed 'in_progress' pointing at dead
      // session ids. A switch is now always park-then-start.
      parkActiveTask(ctx.config, task.id)
      restartOrchestrator(ctx.config, DAEMON_URL, token, pin, brief)
    }

    const newOid = orchestratorId()
    const updated = updateTask(task.id, {
      status: 'in_progress',
      ...(newOid ? { addSessionId: newOid } : {}),
    })
    return { task: updated, orchestrator: orchestratorStatus() }
  })

  // Park: snapshot the active task's terminal history to disk and stop its
  // processes. Resume re-spawns them and the UI replays the saved scrollback.
  scope.post<{ Params: { id: string } }>('/api/tasks/:id/park', async (req, reply) => {
    const task = getTask(req.params.id)
    if (!task) {
      reply.code(404)
      return { error: 'task not found' }
    }
    const manifest = parkTask(ctx.config, task.id)
    if (!manifest) {
      reply.code(409)
      return { error: 'task has no running session to park' }
    }
    const updated = updateTask(task.id, { status: 'parked' })
    return { task: updated, manifest }
  })

  scope.post<{ Params: { id: string } }>('/api/tasks/:id/resume', async (req, reply) => {
    const task = getTask(req.params.id)
    if (!task) {
      reply.code(404)
      return { error: 'task not found' }
    }
    const result = resumeTask(ctx.config, task.id, DAEMON_URL, token)
    if (!result) {
      reply.code(409)
      return { error: 'no parked history for this task' }
    }
    resumeMaps.set(task.id, result.idMap)
    const updated = updateTask(task.id, {
      status: 'in_progress',
      setSessionIds: result.newSessionIds,
    })
    return {
      task: updated,
      orchestrator: orchestratorStatus(),
      pin: result.manifest.pin,
      sessions: result.manifest.sessions.map((s) => ({
        oldId: s.oldId,
        newId: result.idMap[s.oldId] ?? null,
        role: s.role,
        order: s.order,
      })),
    }
  })

  scope.get<{ Params: { id: string } }>('/api/tasks/:id/parked', async (req, reply) => {
    const manifest = parkedManifest(req.params.id)
    if (!manifest) {
      reply.code(404)
      return { error: 'not parked' }
    }
    return { manifest }
  })

  // Saved scrollback for a resumed session: resolve its new id back to the old
  // id it was restored from, then read that history log.
  scope.get<{ Params: { id: string; newId: string } }>(
    '/api/tasks/:id/sessions/:newId/history',
    async (req, reply) => {
      const map = resumeMaps.get(req.params.id) ?? {}
      const oldId =
        Object.entries(map).find(([, nid]) => nid === req.params.newId)?.[0] ?? req.params.newId
      const output = readParkedHistory(req.params.id, oldId)
      if (output === null) {
        reply.code(404)
        return { error: 'no history' }
      }
      return { output, parked: true }
    },
  )
}
