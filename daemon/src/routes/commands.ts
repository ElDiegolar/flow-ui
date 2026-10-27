/**
 * Lists the team's configured commands (flow.config.json `commands`) for a
 * repo or the workspace. Running one goes through POST /api/sessions with
 * command "run" (see sessions.ts).
 */
import type { FastifyInstance } from 'fastify'
import { listCommands } from '../commands.ts'
import type { RouteContext } from './context.ts'

export function registerCommandRoutes(scope: FastifyInstance, ctx: RouteContext) {
  scope.get<{ Querystring: { category?: string; repo?: string } }>('/api/commands', async (req) => {
    const { category, repo } = req.query
    const commands = listCommands(ctx.config, category || undefined, repo || undefined)
    return {
      commands: commands.map((c) => ({
        id: c.id,
        label: c.label,
        scope: c.scope,
        confirm: c.confirm,
      })),
    }
  })
}
