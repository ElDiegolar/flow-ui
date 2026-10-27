/**
 * Project standards the workspace hands to the agents it spawns.
 *
 * A standard is a markdown file in `<workspace>/<standardsDir>/`, with
 * frontmatter naming the categories it governs:
 *
 *     ---
 *     applies: [frontends]
 *     ---
 *     # Frontend standards
 *     - ...
 *
 * Injection rather than a tool call is deliberate. A sub-agent that has to
 * *choose* to fetch its standards mostly won't — it starts editing, and the
 * conventions only surface at review. Putting them in the first turn costs a
 * few hundred tokens on the repos that have them and nothing anywhere else.
 *
 * Read fresh on every lookup, so a standard written by AI Setup (or by hand)
 * applies to the next spawn without a daemon restart.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { learningsFor } from './learnings.ts'
import { workspacePath } from './common/config.ts'
import type { FlowConfig } from './common/types.ts'

export type Standard = {
  /** File stem, e.g. 'frontends'. */
  id: string
  /** Categories this governs, lowercased. */
  applies: string[]
  title: string
  body: string
}

/** Splits `---` frontmatter from the body. Only `key: value` lines are read. */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {}
  if (!text.startsWith('---')) return { meta, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { meta, body: text }
  for (const line of text.slice(3, end).split('\n')) {
    const m = line.match(/^\s*([A-Za-z_-]+)\s*:\s*(.*)$/)
    if (m) meta[m[1].toLowerCase()] = m[2].trim()
  }
  return { meta, body: text.slice(end + 4).replace(/^\s*\n/, '') }
}

/** `[a, b]`, `a, b` or `a` → lowercased names. */
function parseList(v: string | undefined): string[] {
  if (!v) return []
  return v
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) =>
      s
        .trim()
        .replace(/^["']|["']$/g, '')
        .toLowerCase(),
    )
    .filter(Boolean)
}

function parseTitle(body: string): string {
  const m = body.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : 'Project standards'
}

/** Every standard in the workspace's standards dir. */
export function loadStandards(config: FlowConfig): Standard[] {
  const dir = workspacePath(config, config.standardsDir)
  if (!dir || !existsSync(dir)) return []
  const out: Standard[] = []
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.md')) continue
    try {
      const { meta, body } = parseFrontmatter(readFileSync(path.join(dir, f), 'utf8'))
      const applies = parseList(meta.applies)
      if (!applies.length) continue // not addressable, skip it
      out.push({ id: f.replace(/\.md$/, ''), applies, title: parseTitle(body), body })
    } catch {
      /* unreadable file — skip rather than fail the spawn */
    }
  }
  return out
}

/** Standards governing a given repo's category. Empty for most repos, which is the point. */
export function standardsFor(config: FlowConfig, category?: string): Standard[] {
  if (!category) return []
  const key = category.toLowerCase()
  return loadStandards(config).filter((s) => s.applies.includes(key))
}

/**
 * Prepend the project context an agent should start with: the standards
 * governing this repo's category, plus any learnings recorded on earlier work
 * here. Returns the prompt unchanged when neither applies, so the common case
 * costs nothing.
 */
export function withStandards(
  config: FlowConfig,
  prompt: string | undefined,
  category?: string,
  repo?: string,
): string | undefined {
  const applicable = standardsFor(config, category)
  // Only reviewed learnings — see learnings.ts for why unreviewed ones are
  // deliberately withheld from the agents that produced them.
  const learnings = learningsFor(category, repo)
  if (!applicable.length && !learnings.length) return prompt

  const parts: string[] = []
  if (applicable.length) {
    parts.push(
      'Standards for this repo — follow them; they are not optional and they',
      'override your own defaults where the two disagree.',
      '',
      ...applicable.map((s) => s.body.trim()),
      '',
    )
  }
  if (learnings.length) {
    parts.push(
      'Learned on previous work here. Treat these as established unless you find',
      'concrete evidence they are wrong — in which case say so rather than',
      'silently doing it differently.',
      '',
      ...learnings.map((l) => `- ${l.title}: ${l.body.trim()}`),
      '',
    )
  }
  parts.push('--- end of project context ---', '')
  const preamble = parts.join('\n')
  return prompt ? `${preamble}${prompt}` : preamble
}
