/**
 * The workspace's project context files, loaded for an agent up front.
 *
 * The helper keeps its context in markdown: at the root, CLAUDE.md / AGENTS.md
 * say "Read CONTEXT.md" and "Read projects/CONTEXT.md"; each repo has an
 * AGENTS.md pointing at its own CONTEXT.md (or TEMPLATE_CONTEXT.md). The CLIs
 * only auto-load their own entry file (claude: CLAUDE.md up the tree; codex:
 * AGENTS.md from the git root down to cwd) and never follow its links, so what
 * the context actually says reaches the agent only if the model decides to open
 * those files. A custom model often doesn't, and a claude sub-agent never sees a
 * repo's AGENTS.md at all.
 *
 * This follows the links deterministically and returns the documents as one
 * block, minus whatever the engine already loads itself, so nothing is paid for
 * twice.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { Engine, FlowConfig } from './common/types.ts'

/** Upper bound on the injected block — the whole set is ~20–35k chars today. */
const MAX_CHARS = 60000
const ENTRY: Record<Engine, string> = { claude: 'CLAUDE.md', codex: 'AGENTS.md' }
const LINK = /\]\(([^)#\s]+\.md)\)/g
const DIRECTIVE = /^\s*(?:[-*]\s+)?(?:Read|Use)\b/

const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}
const inside = (root: string, p: string) => {
  const rel = path.relative(root, p)
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** One level's documents: its entry file, then what the entry links to. */
function levelDocs(root: string, dir: string, engine: Engine): string[] {
  // CLAUDE.md and AGENTS.md at one level are two front doors to the same
  // context — keep one: the engine's own if present, else the other.
  const own = path.join(dir, ENTRY[engine])
  const other = path.join(dir, ENTRY[engine === 'claude' ? 'codex' : 'claude'])
  const entry = existsSync(own) ? own : existsSync(other) ? other : null
  if (!entry) return []
  const docs = [entry]
  // Only links the entry tells the agent to load ("Read X", "Use X as the
  // primary context") — not ones it merely mentions, like CLAUDE.md's pointer
  // to the 20k-char GUARDRAILS.md that the guard skills already distil.
  for (const line of readFileSync(entry, 'utf8').split('\n')) {
    if (!DIRECTIVE.test(line)) continue
    for (const m of line.matchAll(LINK)) {
      const target = path.resolve(dir, m[1])
      if (inside(root, target) && existsSync(target)) docs.push(target)
    }
  }
  // Repo AGENTS.md: "TEMPLATE_CONTEXT.md if it exists, otherwise CONTEXT.md".
  if (existsSync(path.join(dir, 'TEMPLATE_CONTEXT.md')))
    return docs.filter((d) => d !== path.join(dir, 'CONTEXT.md'))
  return docs
}

/** Files the engine loads by itself when started in `cwd`. */
function autoLoaded(engine: Engine, cwd: string): Set<string> {
  const out = new Set<string>()
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const f = path.join(dir, ENTRY[engine])
    if (existsSync(f)) out.add(real(f))
    // codex stops at the git root; claude keeps walking to the filesystem root.
    if (engine === 'codex' && existsSync(path.join(dir, '.git'))) break
    if (path.dirname(dir) === dir) break
  }
  return out
}

/**
 * The context block for an agent on `engine`, started in `cwd`, optionally
 * working in `repoPath`. Empty string when there is nothing it lacks.
 */
export function projectContext(
  config: FlowConfig,
  engine: Engine,
  cwd: string,
  repoPath?: string | null,
): string {
  const root = config.workspace ?? cwd
  const skip = autoLoaded(engine, cwd)
  const seen = new Set<string>()
  const docs: string[] = []
  for (const dir of [root, ...(repoPath ? [repoPath] : [])]) {
    for (const d of levelDocs(root, dir, engine)) {
      const r = real(d)
      if (seen.has(r)) continue
      seen.add(r)
      if (!skip.has(r)) docs.push(d)
    }
  }
  if (!docs.length) return ''

  const parts = [
    "PROJECT CONTEXT — the workspace's context files, loaded for you (no need to open them):",
  ]
  let size = parts[0].length
  for (const d of docs) {
    const body = readFileSync(d, 'utf8').trim()
    const block = `\n\n===== ${path.relative(root, d)} =====\n${body}`
    if (size + block.length > MAX_CHARS) {
      parts.push(
        `\n\n(${path.relative(root, d)} and later files omitted for size — open them if needed.)`,
      )
      break
    }
    parts.push(block)
    size += block.length
  }
  return parts.join('')
}
