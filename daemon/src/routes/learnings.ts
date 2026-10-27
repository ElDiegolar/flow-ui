/**
 * Learnings recorded while working. Reviewed here; never written to the helper.
 */
import type { FastifyInstance } from 'fastify'
import {
  deleteLearning,
  listLearnings,
  promotionTarget,
  recordLearning,
  setLearningStatus,
  type LearningStatus,
} from '../learnings.ts'

const STATUSES: LearningStatus[] = ['new', 'keep', 'promote', 'discard']

export function registerLearningRoutes(scope: FastifyInstance) {
  scope.get('/api/learnings', async () => ({
    learnings: listLearnings().map((l) => ({ ...l, promotionTarget: promotionTarget(l) })),
  }))

  scope.post<{
    Body: { title?: string; body?: string; category?: string; repo?: string; source?: string }
  }>('/api/learnings', async (req, reply) => {
    try {
      const { title = '', body = '', category, repo, source } = req.body ?? {}
      return { learning: recordLearning({ title, body, category, repo, source }) }
    } catch (e) {
      reply.code(400)
      return { error: (e as Error).message }
    }
  })

  scope.patch<{ Params: { id: string }; Body: { status?: LearningStatus } }>(
    '/api/learnings/:id',
    async (req, reply) => {
      const status = req.body?.status
      if (!status || !STATUSES.includes(status)) {
        reply.code(400)
        return { error: `status must be one of ${STATUSES.join(', ')}` }
      }
      const updated = setLearningStatus(req.params.id, status)
      if (!updated) {
        reply.code(404)
        return { error: 'not found' }
      }
      return { learning: { ...updated, promotionTarget: promotionTarget(updated) } }
    },
  )

  scope.delete<{ Params: { id: string } }>('/api/learnings/:id', async (req, reply) => {
    if (!deleteLearning(req.params.id)) {
      reply.code(404)
      return { error: 'not found' }
    }
    return { ok: true }
  })
}
