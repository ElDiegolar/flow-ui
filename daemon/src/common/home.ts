/**
 * Where Flow keeps its own state — the one place that knows.
 *
 * Every module asks here for its paths, so a second instance or the e2e suite
 * can point the whole daemon elsewhere with FLOW_HOME.
 */
import { homedir } from 'node:os'
import path from 'node:path'

export const FLOW_HOME = process.env.FLOW_HOME ?? path.join(homedir(), '.flow-ui')

/** An absolute path under the data dir. */
export const homePath = (...parts: string[]) => path.join(FLOW_HOME, ...parts)

export const HOME_FILES = {
  token: homePath('token'),
  settings: homePath('settings.json'),
  tasks: homePath('tasks.json'),
  jira: homePath('jira.json'),
  /** The orchestrator's `--mcp-config`. */
  mcpConfig: homePath('mcp.json'),
} as const

export const HOME_DIRS = {
  /** Parked task manifests + scrollback. */
  parked: homePath('tasks'),
  /** Images pasted into a terminal. */
  pastes: homePath('pastes'),
  /** Per-repo code graphs (graphify). */
  graphs: homePath('graphs'),
} as const
