/**
 * The single long-lived control agent: status, lifecycle, and typed prompts.
 */
import type { FastifyInstance } from 'fastify'
import {
  orchestratorStatus,
  promptOrchestrator,
  repinOrchestrator,
  restartOrchestrator,
  startOrchestrator,
  stopOrchestrator,
} from '../orchestrator/index.ts'
import { existsSync } from 'node:fs'
import { resolveRepoPath } from '../common/project.ts'
import { refreshContext } from '../context.ts'
import { findProfile } from '../models.ts'
import { listTasks, updateTask } from '../tasks.ts'
import { getSettings } from '../settings.ts'
import type { RouteContext } from './context.ts'

export function registerOrchestratorRoutes(scope: FastifyInstance, ctx: RouteContext) {
  const { token, daemonUrl: DAEMON_URL } = ctx
  // Orchestrator: a single long-lived `claude` session wired to the flow MCP
  // server. Its terminal uses the same /api/sessions/:id/stream + /replay routes.
  scope.get('/api/orchestrator', async () => orchestratorStatus())

  scope.post<{
    Body: {
      action?: 'start' | 'stop' | 'restart'
      category?: string
      repo?: string
      // Model profile id backing the orchestrator. Omitted → reuse the last-used one.
      agent?: string
    }
  }>('/api/orchestrator', async (req, reply) => {
    const action = req.body?.action
    const { category, repo, agent } = req.body ?? {}
    // Checked up front so a bad pick never stops the running orchestrator first.
    if (agent && !findProfile(getSettings().models, agent)) {
      reply.code(400)
      return { error: `unknown model "${agent}" — add it in Setup → Models` }
    }
    // Pin the orchestrator to a project so it gets the right working context.
    const pin = category && repo ? { category, repo } : undefined
    if (action === 'start')
      return startOrchestrator(ctx.config, DAEMON_URL, token, pin, undefined, agent)
    if (action === 'stop') return stopOrchestrator()
    if (action === 'restart')
      return restartOrchestrator(ctx.config, DAEMON_URL, token, pin, undefined, agent)
    reply.code(400)
    return { error: 'action must be "start", "stop", or "restart"' }
  })

  // Re-pin WITHOUT a restart: the live orchestrator keeps its conversation
  // (e.g. the ticket brief) and is told about the new project. The task that
  // owns this orchestrator follows, so a later Start work uses the same pin.
  scope.post<{ Body: { category?: string; repo?: string } }>(
    '/api/orchestrator/pin',
    async (req, reply) => {
      const { category, repo } = req.body ?? {}
      const repoPath = category && repo ? resolveRepoPath(ctx.config, category, repo) : null
      if (!category || !repo || !repoPath || !existsSync(repoPath)) {
        reply.code(400)
        return { error: 'category and repo must name a cloned repo' }
      }
      const status = repinOrchestrator(ctx.config, { category, repo })
      const owner = status.id
        ? listTasks().find((t) => t.status === 'in_progress' && t.sessionIds.includes(status.id!))
        : undefined
      if (owner && (owner.category !== category || owner.repo !== repo))
        updateTask(owner.id, { category, repo })
      await refreshContext(ctx.config)
      return status
    },
  )

  // Type a prompt into the running orchestrator (Visual tab "Automate" button).
  scope.post<{ Body: { text?: string } }>('/api/orchestrator/prompt', async (req, reply) => {
    const text = req.body?.text
    if (!text) {
      reply.code(400)
      return { error: 'text required' }
    }
    if (!promptOrchestrator(text)) {
      reply.code(409)
      return { error: 'orchestrator not running' }
    }
    return { ok: true }
  })
}
