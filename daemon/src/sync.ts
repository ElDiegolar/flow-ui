/**
 * Git sync state for every project repo under the workspace.
 *
 * Two costs are deliberately separated. Counting how far a branch is behind its
 * upstream is a local ref comparison and effectively free, but it is only as
 * truthful as the last `git fetch` — so reads never touch the network, and
 * refreshing remote refs is an explicit background job. `fetchedAt` travels
 * with every entry so the UI can say how stale the answer is instead of
 * implying it is live.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { listProjects, resolveRepoPath } from './common/project.ts'
import type { FlowConfig } from './common/types.ts'

const exec = promisify(execFile)

export type SyncEntry = {
  /** `${category}/${repo}`. */
  name: string
  category: string | null
  repo: string | null
  branch: string | null
  /** Commits upstream has that we don't. null when there is no upstream. */
  behind: number | null
  /** Commits we have that upstream doesn't. */
  ahead: number | null
  /** Uncommitted changes present (tracked or untracked). */
  dirty: boolean
  /** True when behind > 0 — the thing the UI warns about. */
  outOfDate: boolean
  /** When we last refreshed this repo's remote refs (ms), or null if never. */
  fetchedAt: number | null
  error: string | null
}

export type SyncReport = {
  projects: SyncEntry[]
  /** Oldest fetch across everything — how stale the whole report is. */
  fetchedAt: number | null
  refreshing: boolean
}

// Last successful fetch per directory. In memory only: a restart just means the
// first report reads as never-fetched until the background refresh lands.
const lastFetch = new Map<string, number>()
let refreshing = false

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

const blank = (name: string, category: string | null, repo: string | null): SyncEntry => ({
  name,
  category,
  repo,
  branch: null,
  behind: null,
  ahead: null,
  dirty: false,
  outOfDate: false,
  fetchedAt: null,
  error: null,
})

/**
 * Read one repo's sync state. No network — the behind/ahead counts reflect
 * whatever the last fetch left in the remote-tracking refs.
 */
export async function readSync(
  dir: string,
  name: string,
  category: string | null = null,
  repo: string | null = null,
): Promise<SyncEntry> {
  const entry = blank(name, category, repo)
  entry.fetchedAt = lastFetch.get(dir) ?? null
  if (!existsSync(dir)) {
    entry.error = 'not on disk'
    return entry
  }
  try {
    entry.branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  } catch {
    entry.error = 'not a git repository'
    return entry
  }
  try {
    entry.dirty = (await git(dir, ['status', '--porcelain=v1'])).trim().length > 0
  } catch {
    /* leave dirty false — the count below is the part that matters */
  }
  try {
    // "<ahead>\t<behind>" relative to the upstream. Throws when the branch has
    // no upstream configured, which is a normal state, not an error.
    const out = (await git(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).trim()
    const [ahead, behind] = out.split(/\s+/).map((n) => Number.parseInt(n, 10))
    if (Number.isFinite(ahead)) entry.ahead = ahead
    if (Number.isFinite(behind)) {
      entry.behind = behind
      entry.outOfDate = behind > 0
    }
  } catch {
    /* no upstream — behind/ahead stay null and the UI shows nothing */
  }
  return entry
}

/** Every repo directory we track. */
function targets(config: FlowConfig): { dir: string; name: string; cat: string; repo: string }[] {
  const out: { dir: string; name: string; cat: string; repo: string }[] = []
  for (const p of listProjects(config)) {
    for (const r of p.repos) {
      const dir = resolveRepoPath(config, p.name, r)
      if (dir && existsSync(dir)) out.push({ dir, name: `${p.name}/${r}`, cat: p.name, repo: r })
    }
  }
  return out
}

/** Current sync state for everything. Cheap — safe to call on every poll. */
export async function syncReport(config: FlowConfig): Promise<SyncReport> {
  const projects = await Promise.all(
    targets(config).map((t) => readSync(t.dir, t.name, t.cat, t.repo)),
  )
  const stamps = projects.map((e) => e.fetchedAt).filter((n): n is number => n != null)
  return {
    projects,
    fetchedAt: stamps.length ? Math.min(...stamps) : null,
    refreshing,
  }
}

/**
 * Refresh remote refs so the next read is truthful. This is the part that costs
 * network, so it runs a few repos at a time and is never in the request path of
 * a plain read. A repo that fails to fetch (no remote, no auth, offline) keeps
 * its previous `fetchedAt` rather than poisoning the report.
 */
export async function refreshRemotes(config: FlowConfig, concurrency = 4): Promise<number> {
  if (refreshing) return 0
  refreshing = true
  const dirs = targets(config).map((t) => t.dir)
  let ok = 0
  try {
    const queue = [...dirs]
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let dir = queue.shift(); dir; dir = queue.shift()) {
        try {
          await git(dir, ['fetch', '--quiet', '--all'])
          lastFetch.set(dir, Date.now())
          ok++
        } catch {
          /* offline / no remote / auth — leave the previous stamp in place */
        }
      }
    })
    await Promise.all(workers)
  } finally {
    refreshing = false
  }
  return ok
}
