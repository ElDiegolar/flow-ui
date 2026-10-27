/**
 * Learnings the agents record while working, kept in this repo.
 *
 * Kept in this repo's `daemon/learnings/` directory, separate from the
 * workspace's `standards/` (which people author). Learnings are ours: they are
 * authored here, committed here, and never pushed anywhere on their own.
 *
 * Promotion into the workspace's standards is a HUMAN decision. Nothing in this
 * file writes to the workspace's standards — the UI shows the candidate and the
 * path it would belong at, and a person decides whether it becomes a house rule.
 * An agent noticing something once is not the same as it being a house rule.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LEARNINGS_DIR = path.resolve(__dirname, '..', 'learnings')

/**
 * `new` — recorded, not yet reviewed.
 * `keep` — reviewed and worth applying; injected into future agent prompts.
 * `promote` — flagged for the workspace's standards; the UI shows what to paste, we never write it.
 * `discard` — reviewed and rejected; kept as a record so it isn't re-learned.
 */
export type LearningStatus = 'new' | 'keep' | 'promote' | 'discard'

export type Learning = {
  id: string
  /** `category/repo` it applies to, lowercased, or '*' for workspace-wide. */
  applies: string
  title: string
  body: string
  status: LearningStatus
  recordedAt: number
  /** Session or agent that recorded it, for provenance. */
  source: string | null
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'learning'
  )
}

function parse(id: string, text: string): Learning | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return null
  const meta: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/)
    if (kv) meta[kv[1]] = kv[2].trim()
  }
  const status = (meta.status ?? 'new') as LearningStatus
  return {
    id,
    applies: (meta.applies ?? '*').toLowerCase(),
    title: meta.title ?? id,
    body: m[2].trim(),
    status: ['new', 'keep', 'promote', 'discard'].includes(status) ? status : 'new',
    recordedAt: Number.parseInt(meta.recordedAt ?? '0', 10) || 0,
    source: meta.source || null,
  }
}

function serialise(l: Learning): string {
  return [
    '---',
    `title: ${l.title}`,
    `applies: ${l.applies}`,
    `status: ${l.status}`,
    `recordedAt: ${l.recordedAt}`,
    ...(l.source ? [`source: ${l.source}`] : []),
    '---',
    '',
    l.body.trim(),
    '',
  ].join('\n')
}

export function listLearnings(): Learning[] {
  if (!existsSync(LEARNINGS_DIR)) return []
  const out: Learning[] = []
  for (const f of readdirSync(LEARNINGS_DIR).sort()) {
    if (!f.endsWith('.md')) continue
    try {
      const l = parse(f.replace(/\.md$/, ''), readFileSync(path.join(LEARNINGS_DIR, f), 'utf8'))
      if (l) out.push(l)
    } catch {
      /* unreadable — skip rather than fail the caller */
    }
  }
  return out.sort((a, b) => b.recordedAt - a.recordedAt)
}

export type RecordInput = {
  title: string
  body: string
  category?: string
  repo?: string
  source?: string
}

/** Write a new learning. Returns it, or throws if title/body are empty. */
export function recordLearning(input: RecordInput): Learning {
  const title = input.title?.trim()
  const body = input.body?.trim()
  if (!title) throw new Error('title is required')
  if (!body) throw new Error('body is required')

  const applies =
    input.category && input.repo ? `${input.category}/${input.repo}`.toLowerCase() : '*'
  const learning: Learning = {
    id: `${slug(applies === '*' ? 'workspace' : applies)}--${slug(title)}`,
    applies,
    title,
    body,
    status: 'new',
    recordedAt: Date.now(),
    source: input.source?.trim() || null,
  }
  mkdirSync(LEARNINGS_DIR, { recursive: true })
  writeFileSync(path.join(LEARNINGS_DIR, `${learning.id}.md`), serialise(learning))
  return learning
}

export function setLearningStatus(id: string, status: LearningStatus): Learning | null {
  const file = path.join(LEARNINGS_DIR, `${id}.md`)
  if (!existsSync(file)) return null
  const current = parse(id, readFileSync(file, 'utf8'))
  if (!current) return null
  const next = { ...current, status }
  writeFileSync(file, serialise(next))
  return next
}

export function deleteLearning(id: string): boolean {
  const file = path.join(LEARNINGS_DIR, `${id}.md`)
  if (!existsSync(file)) return false
  unlinkSync(file)
  return true
}

/**
 * Learnings that should shape work on a repo: those scoped to it plus the
 * workspace-wide ones. Only `keep` and `promote` qualify — a `new` learning is
 * unreviewed, and feeding unreviewed observations straight back to the agents
 * that produced them is how a wrong guess becomes a house rule.
 */
export function learningsFor(category?: string, repo?: string): Learning[] {
  const key = category && repo ? `${category}/${repo}`.toLowerCase() : null
  return listLearnings().filter(
    (l) =>
      (l.status === 'keep' || l.status === 'promote') && (l.applies === '*' || l.applies === key),
  )
}

/** Where a promoted learning would belong in the workspace — shown, never written. */
export function promotionTarget(l: Learning): string {
  if (l.applies === '*') return 'AGENTS.md'
  return `standards/${l.applies.split('/')[0]}.md`
}
