/**
 * What every route group needs from the daemon: the workspace config, the
 * session token, and the loopback URL the MCP server calls back on. Anything
 * narrower than that stays module-local to the group that uses it.
 *
 * `config` is a getter over the live config, not a snapshot: AI Setup re-resolves
 * the workspace (reloadConfig) and every route must see the new value. Routes
 * therefore read `ctx.config` inside each handler, never destructure it at
 * registration time.
 */
import type { FlowConfig } from '../common/types.ts'

export type RouteContext = {
  readonly config: FlowConfig
  token: string
  daemonUrl: string
}
