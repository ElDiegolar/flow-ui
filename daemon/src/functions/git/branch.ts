/**
 * Switch one repo's branch.
 *
 * Switch one repo's branch, unattended. Where a dirty tree could be discarded
 * or stashed, this always refuses. An agent must never be one call away from
 * `git reset --hard` on someone's work.
 *
 * It runs git directly rather than spawning a PTY: the caller (the orchestrator,
 * via git_branch) needs a structured answer, not a terminal.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { resolveRepoPath } from '../../common/project.ts'
import type { FlowConfig } from '../../common/types.ts'

const exec = promisify(execFile)

async function git(cwd: string, args: string[]) {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}

export type BranchResult = {
  category: string
  repo: string
  previous: string
  branch: string
  created: boolean
  /** What `git pull --ff-only` did, or why it was skipped. */
  pull: string
}

export async function switchBranch(
  config: FlowConfig,
  category: string,
  repo: string,
  branch: string,
  opts: { create?: boolean } = {},
): Promise<BranchResult> {
  const cwd = resolveRepoPath(config, category, repo)
  if (!cwd || !existsSync(cwd)) throw new Error(`repo not found: ${category}/${repo}`)
  const name = branch.trim()
  // Same validation the script does before touching anything.
  try {
    await git(cwd, ['check-ref-format', '--branch', name])
  } catch {
    throw new Error(`invalid branch name: ${JSON.stringify(name)}`)
  }
  const previous = await git(cwd, ['branch', '--show-current'])
  const dirty = await git(cwd, ['status', '--porcelain', '--untracked-files=all'])
  let created = false

  if (previous !== name) {
    if (dirty) {
      const n = dirty.split('\n').length
      throw new Error(
        `${category}/${repo} has ${n} uncommitted change${n === 1 ? '' : 's'} — commit or ` +
          `stash them first. (This never discards them.)`,
      )
    }
    const exists = await git(cwd, ['rev-parse', '--verify', '--quiet', name]).then(
      () => true,
      () => false,
    )
    const onRemote = await git(cwd, ['rev-parse', '--verify', '--quiet', `origin/${name}`]).then(
      () => true,
      () => false,
    )
    if (!exists && !onRemote && !opts.create)
      throw new Error(`no branch "${name}" locally or on origin — pass create to start it`)
    try {
      // A plain checkout also creates a local branch tracking origin/<name>.
      await git(cwd, exists || onRemote ? ['checkout', name] : ['checkout', '-b', name])
      created = !exists && !onRemote
    } catch (e) {
      throw new Error(`checkout failed: ${(e as { stderr?: string }).stderr?.trim() || e}`)
    }
  }

  // The script pulls after switching. Fast-forward only here: a merge commit
  // made on someone's behalf is not a "switch".
  let pull = 'no upstream'
  try {
    await git(cwd, ['rev-parse', '--abbrev-ref', '@{u}'])
    try {
      const out = await git(cwd, ['pull', '--ff-only'])
      pull = out.split('\n').pop() || 'up to date'
    } catch (e) {
      pull = `not pulled: ${(e as { stderr?: string }).stderr?.trim().split('\n').pop() ?? 'failed'}`
    }
  } catch {
    /* no upstream — nothing to pull */
  }

  return {
    category,
    repo,
    previous,
    branch: name,
    created,
    pull,
  }
}
