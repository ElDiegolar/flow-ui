/**
 * AI Setup routes: start the setup session, and re-read the workspace config
 * once the agent has written its files, so the project list updates without a
 * daemon restart.
 */
import type { FastifyInstance } from 'fastify'
import { reloadConfig, getConfig } from '../common/config.ts'
import { publish } from '../common/bus.ts'
import { activeContext } from '../context.ts'
import { AiSetupError, startAiSetup, type AiSetupBody } from '../aiSetup.ts'
import type { RouteContext } from './context.ts'

export function registerAiSetupRoutes(scope: FastifyInstance, ctx: RouteContext) {
  scope.post<{ Body: AiSetupBody }>('/api/setup/ai', async (req, reply) => {
    try {
      return startAiSetup(ctx, req.body ?? {})
    } catch (err) {
      if (err instanceof AiSetupError) {
        reply.code(err.status)
        return { error: err.message }
      }
      throw err
    }
  })

  scope.post('/api/config/reload', async () => {
    reloadConfig()
    const config = getConfig()
    publish({ type: 'context', context: activeContext() })
    publish({ type: 'projects-changed', reason: 'config-reload' })
    return { ok: true, workspace: config.workspace }
  })
}
