/**
 * The daemon's external MCP connections (Atlassian, Figma): status, the manual
 * Connect / Disconnect / Reset the Setup tab and first-run intro drive, and the
 * Figma proxy the orchestrator's figma_call tool goes through.
 */
import { mkdirSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { publish } from '../common/bus.ts'
import { figmaAssetsStatus, toWindowsPath } from '../integrations/figmaAssets.ts'
import {
  callTool,
  connect,
  disconnect,
  hubStatus,
  listTools,
  resetServer,
  type ServerName,
  type ToolResult,
} from '../integrations/hub.ts'
import { jiraSites, lastJiraAccess } from '../integrations/jiraBoard.ts'
import { getSettings } from '../settings.ts'
import type { RouteContext } from './context.ts'

const isServer = (n: string): n is ServerName => n === 'atlassian' || n === 'figma'

export function registerIntegrationRoutes(scope: FastifyInstance, _ctx: RouteContext) {
  const announce = () => publish({ type: 'integrations', status: hubStatus() })

  // Atlassian's status carries whether the login can actually read Jira: a
  // Confluence-only consent connects fine and then fails every board call.
  const withAccess = async () => {
    const st = hubStatus()
    let jiraAccess: { sites: number; withoutJira: string[] } | null = lastJiraAccess()
    if (st.atlassian.state === 'connected' && !jiraAccess) {
      try {
        await jiraSites()
      } catch {
        /* unknown — leave null */
      }
      jiraAccess = lastJiraAccess()
    }
    return {
      ...st,
      atlassian: {
        ...st.atlassian,
        jiraAccess: st.atlassian.state === 'connected' ? jiraAccess : null,
      },
      // Whether Figma may write the frame's assets where get_design_context
      // sends them — Setup walks the developer through allow-listing it.
      figma: { ...st.figma, assets: await figmaAssetsStatus() },
    }
  }
  scope.get('/api/integrations', withAccess)

  scope.post<{ Params: { name: string; action: string } }>(
    '/api/integrations/:name/:action',
    async (req, reply) => {
      const { name, action } = req.params
      if (!isServer(name)) {
        reply.code(404)
        return { error: `unknown integration: ${name}` }
      }
      let result
      if (action === 'connect') {
        if (name === 'figma') await figmaAssetsStatus(true)
        // Answer immediately: a manual Atlassian connect waits on a human in a
        // browser for up to minutes. The UI follows progress via the status
        // (and the 'integrations' event), not this request.
        void connect(name, true).then(announce)
        await new Promise((r) => setTimeout(r, 300))
        result = (await withAccess())[name]
      } else if (action === 'disconnect') result = await disconnect(name)
      else if (action === 'reset') result = await resetServer(name)
      else {
        reply.code(400)
        return { error: 'action must be connect, disconnect or reset' }
      }
      announce()
      return result
    },
  )

  // ── Figma proxy ─────────────────────────────────────────────────────────────
  scope.get('/api/figma/tools', async (_req, reply) => {
    try {
      return { tools: await listTools('figma') }
    } catch (e) {
      reply.code(503)
      return { error: (e as Error).message }
    }
  })

  // get_design_context writes the frame's images/vectors/videos into one Figma
  // assets folder (Setup → Behaviour), kept apart from every project; agents
  // copy what they need from there. With no nodeId, Figma uses whatever frame
  // is selected in Figma Desktop. An explicit dirForAssetWrites wins.
  const withAssetsDir = async (tool: string, args: Record<string, unknown>) => {
    if (tool !== 'get_design_context' || args.dirForAssetWrites) return args
    const dir = getSettings().figma.assetsDir
    if (!dir) return args
    mkdirSync(dir, { recursive: true })
    return { ...args, dirForAssetWrites: await toWindowsPath(dir) }
  }

  // The result goes back untouched, images included.
  scope.post<{ Body: { tool?: string; args?: Record<string, unknown> } }>(
    '/api/figma/call',
    async (req, reply) => {
      const tool = req.body?.tool
      if (!tool) {
        reply.code(400)
        return { error: 'tool required' }
      }
      let result: ToolResult
      try {
        const args = { ...(req.body?.args ?? {}) }
        // An empty nodeId fails Figma's pattern check; absent means "selected".
        if (!args.nodeId) delete args.nodeId
        const sent = await withAssetsDir(tool, args)
        result = await callTool('figma', tool, sent)
        // Figma only writes to folders allow-listed in Dev Mode → MCP; name
        // the exact (Windows-side) path so the fix is copy-paste.
        const refusal = result.content.find(
          (c) => c.type === 'text' && /Cannot write to this directory/.test(String(c.text)),
        )
        if (refusal && sent.dirForAssetWrites)
          refusal.text = `${String(refusal.text)} Add this folder there: ${String(sent.dirForAssetWrites)}`
      } catch (e) {
        reply.code(503)
        return { error: (e as Error).message }
      }
      return result
    },
  )
}
