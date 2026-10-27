/**
 * Read-only git inspection for the Diff tab.
 */
import type { FastifyInstance } from 'fastify'
import { switchBranch } from '../functions/git/branch.ts'
import { activeContext, refreshContext } from '../context.ts'
import { gitDiff, gitStatus, type DiffBase } from '../common/git.ts'
import type { RouteContext } from './context.ts'

export function registerGitRoutes(scope: FastifyInstance, ctx: RouteContext) {
  // ── Git diff: review what the agents changed before committing ──────────────
  scope.get<{ Querystring: { category?: string; repo?: string; base?: DiffBase } }>(
    '/api/git/status',
    async (req, reply) => {
      const { category, repo, base } = req.query
      if (!category || !repo) {
        reply.code(400)
        return { error: 'category and repo required' }
      }
      try {
        return await gitStatus(ctx.config, category, repo, base === 'staging' ? 'staging' : 'head')
      } catch (e) {
        reply.code(400)
        return { error: (e as Error).message }
      }
    },
  )

  scope.get<{ Querystring: { category?: string; repo?: string; file?: string; base?: DiffBase } }>(
    '/api/git/diff',
    async (req, reply) => {
      const { category, repo, file, base } = req.query
      if (!category || !repo || !file) {
        reply.code(400)
        return { error: 'category, repo and file required' }
      }
      try {
        return await gitDiff(
          ctx.config,
          category,
          repo,
          file,
          base === 'staging' ? 'staging' : 'head',
        )
      } catch (e) {
        reply.code(400)
        return { error: (e as Error).message }
      }
    },
  )

  // The active context every tab follows: pinned repo + its current branch.
  scope.get('/api/context', async () => refreshContext(ctx.config))

  // Switch a repo's branch (git_branch). Defaults to the active context's repo,
  // and the context is refreshed before answering, so every open tab has moved
  // by the time the caller hears back.
  scope.post<{ Body: { category?: string; repo?: string; branch?: string; create?: boolean } }>(
    '/api/git/branch',
    async (req, reply) => {
      const active = activeContext()
      const category = req.body?.category ?? active.category
      const repo = req.body?.repo ?? active.repo
      const branch = req.body?.branch
      if (!category || !repo || !branch) {
        reply.code(400)
        return { error: 'branch required (and category + repo when no project is pinned)' }
      }
      try {
        const result = await switchBranch(ctx.config, category, repo, branch, {
          create: req.body?.create === true,
        })
        return { ...result, context: await refreshContext(ctx.config) }
      } catch (e) {
        reply.code(409)
        return { error: (e as Error).message }
      }
    },
  )
}
