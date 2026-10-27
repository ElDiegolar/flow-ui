/**
 * Git sync state for every project repo under the workspace.
 */
import type { FastifyInstance } from 'fastify'
import { refreshRemotes, syncReport } from '../sync.ts'
import type { RouteContext } from './context.ts'

export function registerSyncRoutes(scope: FastifyInstance, ctx: RouteContext) {
  // ── Sync: is each repo behind its remote? ──────────────────────────────────
  // Cheap read of local refs — see sync.ts for why fetching is a separate job.
  scope.get('/api/sync', async () => syncReport(ctx.config))

  // Force a remote-ref refresh, then return the freshened report. Used by the
  // UI's explicit "check now"; the background timer covers the passive case.
  scope.post('/api/sync/refresh', async () => {
    await refreshRemotes(ctx.config)
    return syncReport(ctx.config)
  })
}
