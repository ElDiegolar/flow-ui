/**
 * Workspace inventory: the categories and repos under the workspace.
 */
import type { FastifyInstance } from 'fastify'
import { listProjects } from '../common/project.ts'
import type { RouteContext } from './context.ts'

export function registerProjectRoutes(scope: FastifyInstance, ctx: RouteContext) {
  scope.get('/api/projects', async () => ({ projects: listProjects(ctx.config) }))
}
