/**
 * First-run readiness: which agents, MCP servers and workspace are configured.
 */
import type { FastifyInstance } from 'fastify'
import { configuredMcpServers, mcpConfigPath, setupReport } from '../setup.ts'
import type { RouteContext } from './context.ts'

export function registerSetupRoutes(scope: FastifyInstance, ctx: RouteContext) {
  scope.get('/api/setup', async () => ({
    ...(await setupReport(ctx.config)),
    mcpConfigPath: mcpConfigPath(),
    mcpServers: configuredMcpServers(),
    workspace: ctx.config.workspace,
  }))
}
