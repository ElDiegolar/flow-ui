/**
 * The ACTIVE CONTEXT: the project the orchestrator is pinned to, and the branch
 * that repo is on right now. Every page keys off it — the Diff and Commit tabs'
 * pickers.
 *
 * The branch is read live from git, not remembered from the pin, because it
 * moves underneath us: a sub-agent checks out a feature branch, the developer
 * switches in a terminal. So it is polled (a `rev-parse` is ~2ms) and every
 * change is pushed over /api/events, which is what lets the other tabs follow
 * without each one re-deriving it.
 */
import { publish } from './common/bus.ts'
import { getConfig } from './common/config.ts'
import { gitBranch } from './common/git.ts'
import { orchestratorStatus } from './orchestrator/index.ts'

export type ActiveContext = {
  /** Orchestrator is up. The pin survives a stop, so the context can outlive it. */
  running: boolean
  category: string | null
  repo: string | null
  /** Current branch of the pinned repo, or null when unpinned / not a git repo. */
  branch: string | null
  /** `category/repo@branch` — stable identity for "did the context move". */
  key: string | null
  /** When the key last changed. */
  since: number
}

let current: ActiveContext = {
  running: false,
  category: null,
  repo: null,
  branch: null,
  key: null,
  since: Date.now(),
}

export function activeContext(): ActiveContext {
  return current
}

/** Recompute now; publishes if anything moved. Cheap enough to call after any
 * action that might have moved it (start, restart, git_branch). */
export async function refreshContext(config = getConfig()): Promise<ActiveContext> {
  const st = orchestratorStatus()
  const branch = st.category && st.repo ? await gitBranch(config, st.category, st.repo) : null
  const key = st.category && st.repo ? `${st.category}/${st.repo}@${branch ?? '?'}` : null
  if (key !== current.key || st.running !== current.running) {
    current = {
      running: st.running,
      category: st.category,
      repo: st.repo,
      branch,
      key,
      since: key !== current.key ? Date.now() : current.since,
    }
    publish({ type: 'context', context: current })
  }
  return current
}

const POLL_MS = Number(process.env.FLOW_CONTEXT_POLL_MS ?? 2000)

export function watchContext() {
  void refreshContext()
  if (POLL_MS <= 0) return
  const t = setInterval(() => void refreshContext(), POLL_MS)
  t.unref?.()
}
