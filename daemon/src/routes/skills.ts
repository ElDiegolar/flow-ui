/**
 * What skills and standards are in play for a project.
 *
 * The list is metadata only. Full file text is fetched per row on expand —
 * shipping every skill and standard body up front was ~81KB on a panel that is
 * collapsed by default and refetched whenever the pin changes.
 */
import type { FastifyInstance } from 'fastify'
import { orchestratorPin } from '../orchestrator/index.ts'
import { readSkill, readStandard, skillsReport } from '../skills.ts'
import type { RouteContext } from './context.ts'

export function registerSkillRoutes(scope: FastifyInstance, ctx: RouteContext) {
  // Defaults to whatever the orchestrator is pinned to, so the UI can just ask.
  scope.get<{ Querystring: { category?: string; repo?: string } }>('/api/skills', async (req) => {
    const pin = orchestratorPin()
    const category = req.query.category ?? pin?.category ?? null
    const repo = req.query.repo ?? pin?.repo ?? null
    return skillsReport(ctx.config, category, repo)
  })

  // Standards are matched by id, so this must come before the :name route —
  // otherwise 'standard' would be read as a skill name.
  scope.get<{ Params: { id: string } }>('/api/skills/standard/:id', async (req, reply) => {
    const standard = readStandard(ctx.config, req.params.id)
    if (!standard) {
      reply.code(404)
      return { error: 'not found' }
    }
    return standard
  })

  scope.get<{ Params: { name: string } }>('/api/skills/:name', async (req, reply) => {
    const detail = readSkill(ctx.config, req.params.name)
    if (!detail) {
      reply.code(404)
      return { error: 'not found' }
    }
    return detail
  })
}
