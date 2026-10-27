/**
 * Daemon settings — Jira access mode, orchestrator engine, and the integration
 * config (routes/integrations.ts drives the connections themselves).
 */
import type { FastifyInstance } from 'fastify'
import { publish } from '../common/bus.ts'
import { disconnect, hubStatus } from '../integrations/hub.ts'
import { findProfile, testProfile, type ModelProfile } from '../models.ts'
import { getSettings, publicSettings, updateSettings, type SettingsPatch } from '../settings.ts'

export function registerSettingsRoutes(scope: FastifyInstance) {
  scope.get('/api/settings', async () => publicSettings())
  scope.put<{ Body: SettingsPatch }>('/api/settings', async (req, reply) => {
    const before = getSettings()
    let next
    try {
      next = updateSettings(req.body ?? {})
    } catch (e) {
      reply.code(400)
      return { error: (e as Error).message }
    }
    // A changed endpoint (or turning a server off) makes the live connection
    // wrong — drop it. Reconnecting is left to the developer / the quiet
    // cached-token path, never done here: this must not open a login window.
    if (
      before.atlassian.url !== next.atlassian.url ||
      (before.atlassian.enabled && !next.atlassian.enabled)
    )
      await disconnect('atlassian')
    if (before.figma.url !== next.figma.url || (before.figma.enabled && !next.figma.enabled))
      await disconnect('figma')
    publish({ type: 'integrations', status: hubStatus() })
    return publicSettings(next)
  })

  // Check a model profile's endpoint from Setup. The body may be an unsaved
  // edit; a missing key falls back to the stored profile's.
  scope.post<{ Body: Partial<ModelProfile> }>('/api/models/test', async (req, reply) => {
    const body = req.body ?? {}
    const stored = body.id ? findProfile(getSettings().models, body.id) : undefined
    const profile = { ...stored, ...body, apiKey: body.apiKey || stored?.apiKey } as ModelProfile
    if (profile.engine !== 'claude' && profile.engine !== 'codex') {
      reply.code(400)
      return { error: 'engine must be claude or codex' }
    }
    return testProfile(profile)
  })
}
