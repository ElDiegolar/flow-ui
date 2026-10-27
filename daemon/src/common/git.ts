/**
 * Read-only git inspection for the Diff tab: list a repo's changed files and
 * show a per-file diff so the user can visually confirm what the agents did
 * before committing. Everything runs in the repo's working dir under the
 * workspace; nothing here writes or commits.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { resolveRepoPath } from './project.ts'
import type { FlowConfig } from './types.ts'

const exec = promisify(execFile)

export type GitFile = {
  /** Path relative to the repo root. */
  path: string
  /** Two-char porcelain status (e.g. ' M', 'A ', '??', 'R '). */
  status: string
  staged: boolean
  untracked: boolean
}

/**
 * What the changes are measured against.
 *  `head`    — uncommitted work only: the classic "what have I not committed".
 *  `staging` — everything this branch carries that the deployed branch doesn't,
 *              committed work included. This is the review question.
 */
export type DiffBase = 'head' | 'staging'

export type GitStatus = {
  category: string
  repo: string
  branch: string
  files: GitFile[]
  clean: boolean
  base: DiffBase
  /** The ref actually compared against, e.g. 'origin/staging'. Null for head. */
  baseRef: string | null
  /** Set when `staging` was asked for but no such branch exists here. */
  baseError: string | null
  /** How far the branch is from that ref, when known. */
  ahead: number | null
  behind: number | null
}

/**
 * Resolve the staging ref for a repo. Prefers the remote-tracking branch — a
 * stale local `staging` would quietly answer the wrong question — and falls
 * back to a local one only if there is no remote copy.
 */
async function resolveStagingRef(cwd: string): Promise<string | null> {
  for (const ref of ['origin/staging', 'staging']) {
    try {
      await git(cwd, ['rev-parse', '--verify', '--quiet', ref])
      return ref
    } catch {
      /* not this one */
    }
  }
  return null
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

function repoDir(config: FlowConfig, category: string, repo: string): string {
  const dir = resolveRepoPath(config, category, repo)
  if (!dir || !existsSync(dir)) throw new Error('repo not found in workspace')
  return dir
}

/** Just the current branch name of a repo, or null if unavailable. Cheap. */
export async function gitBranch(
  config: FlowConfig,
  category: string,
  repo: string,
): Promise<string | null> {
  try {
    const cwd = repoDir(config, category, repo)
    return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  } catch {
    return null
  }
}

export async function gitStatus(
  config: FlowConfig,
  category: string,
  repo: string,
  base: DiffBase = 'head',
): Promise<GitStatus> {
  const cwd = repoDir(config, category, repo)
  let branch = ''
  try {
    branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  } catch {
    throw new Error('not a git repository')
  }

  if (base === 'staging') {
    const baseRef = await resolveStagingRef(cwd)
    if (!baseRef) {
      return {
        category,
        repo,
        branch,
        files: [],
        clean: true,
        base,
        baseRef: null,
        baseError: 'no staging branch in this repo',
        ahead: null,
        behind: null,
      }
    }
    // No `..`: comparing the working tree to the ref, so uncommitted work shows
    // up alongside committed work. That is the whole point of the staging view.
    const out = await git(cwd, ['diff', '--name-status', baseRef])
    const files: GitFile[] = []
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      const code = parts[0]
      // Renames and copies render as "R100\told\tnew" — show the new path.
      const p = parts.length > 2 ? parts[2] : parts[1]
      if (!p) continue
      files.push({ path: p, status: code.slice(0, 2), staged: false, untracked: false })
    }
    files.sort((a, b) => a.path.localeCompare(b.path))
    let ahead: number | null = null
    let behind: number | null = null
    try {
      const counts = (
        await git(cwd, ['rev-list', '--left-right', '--count', `HEAD...${baseRef}`])
      ).trim()
      const [a, b] = counts.split(/\s+/).map((n) => Number.parseInt(n, 10))
      if (Number.isFinite(a)) ahead = a
      if (Number.isFinite(b)) behind = b
    } catch {
      /* counts are a nicety; the file list is the answer */
    }
    return {
      category,
      repo,
      branch,
      files,
      clean: files.length === 0,
      base,
      baseRef,
      baseError: null,
      ahead,
      behind,
    }
  }

  const out = await git(cwd, ['status', '--porcelain=v1'])
  const files: GitFile[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const status = line.slice(0, 2)
    let path = line.slice(3)
    // Renames/copies render as "old -> new"; show the new path.
    const arrow = path.indexOf(' -> ')
    if (arrow !== -1) path = path.slice(arrow + 4)
    // Porcelain quotes paths with special chars; strip surrounding quotes.
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
    const untracked = status === '??'
    files.push({
      path,
      status,
      staged: !untracked && status[0] !== ' ',
      untracked,
    })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return {
    category,
    repo,
    branch,
    files,
    clean: files.length === 0,
    base,
    baseRef: null,
    baseError: null,
    ahead: null,
    behind: null,
  }
}

export async function gitDiff(
  config: FlowConfig,
  category: string,
  repo: string,
  file: string,
  base: DiffBase = 'head',
): Promise<{ path: string; diff: string }> {
  const cwd = repoDir(config, category, repo)
  // Only diff files git actually reports as changed against this same base —
  // never an arbitrary path, and never one the caller's base doesn't include.
  const status = await gitStatus(config, category, repo, base)
  const entry = status.files.find((f) => f.path === file)
  if (!entry) throw new Error('file is not in the changed set')

  if (base === 'staging') {
    if (!status.baseRef) throw new Error('no staging branch in this repo')
    // A file added on this branch has no counterpart in staging, so git needs
    // to be told to treat the missing side as empty rather than erroring.
    const diff = await git(cwd, ['diff', status.baseRef, '--', file])
    return { path: file, diff }
  }
  if (entry.untracked) {
    // Untracked: show the whole file as added. --no-index exits 1 on a diff, so
    // capture stdout from the thrown error rather than treating it as failure.
    try {
      const diff = await git(cwd, ['diff', '--no-index', '--', '/dev/null', file])
      return { path: file, diff }
    } catch (e) {
      return { path: file, diff: (e as { stdout?: string }).stdout ?? '' }
    }
  }
  // Working tree (staged + unstaged) vs HEAD captures everything done so far.
  const diff = await git(cwd, ['diff', 'HEAD', '--', file])
  return { path: file, diff }
}
