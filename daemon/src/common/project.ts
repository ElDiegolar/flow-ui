/**
 * The project tree under the workspace: which categories and repos exist, and
 * where a repo lives on disk. A repo is any direct child of a category folder
 * that is a git repo (a `.git` entry, or a symlink to one). Symlinks are
 * followed, so repos kept elsewhere on disk show up like local clones.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { FlowConfig, ProjectCategory } from './types.ts'
import { projectsRoot } from './config.ts'

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** True when `p` is a git repo (follows symlinks). */
export function isGitRepo(p: string): boolean {
  return isDir(p) && existsSync(path.join(p, '.git'))
}

function subdirs(dir: string): string[] {
  if (!isDir(dir)) return []
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => isDir(path.join(dir, name)))
    .sort()
}

/** The category folder on disk for a (possibly lower-cased) category name. */
function categoryDir(config: FlowConfig, category: string): string | null {
  const root = projectsRoot(config)
  if (!root) return null
  const match = subdirs(root).find((d) => d.toLowerCase() === category.toLowerCase())
  return path.join(root, match ?? category)
}

/** Category folders to show: the configured list, or every folder holding a repo. */
function categoryNames(config: FlowConfig): string[] {
  const root = projectsRoot(config)
  if (!root) return []
  if (config.categories) return config.categories
  return subdirs(root).filter((d) =>
    subdirs(path.join(root, d)).some((r) => isGitRepo(path.join(root, d, r))),
  )
}

export function listProjects(config: FlowConfig): ProjectCategory[] {
  return categoryNames(config).map((name) => {
    const dir = categoryDir(config, name) ?? ''
    return {
      name,
      slug: name.toLowerCase(),
      repos: subdirs(dir).filter((r) => isGitRepo(path.join(dir, r))),
    }
  })
}

/** Absolute path to a repo's working dir, or null if category/repo are not both given
 * or the workspace does not exist. Does not check existence. */
export function resolveRepoPath(
  config: FlowConfig,
  category?: string,
  repo?: string,
): string | null {
  if (!category || !repo) return null
  if (repo.includes('/') || repo.includes('\\') || repo === '..' || repo.startsWith('.'))
    return null
  const dir = categoryDir(config, category)
  return dir ? path.join(dir, repo) : null
}
