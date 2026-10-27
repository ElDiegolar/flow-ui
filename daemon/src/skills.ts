/**
 * What the agents are actually operating under for a given project.
 *
 * Two different things end up in an agent's context and it is easy to lose
 * track of both:
 *  - the workspace's **skills** (`<skillsDir>/<name>/SKILL.md`, default
 *    `.agents/skills`), served to every engine over MCP, and
 *    `.claude/skills/<name>/SKILL.md`, which claude loads itself
 *  - the **standards** injected into the opening prompt (standards.ts)
 *
 * The Orchestrator tab shows both so "why did it do that?" has an answer you
 * can read, rather than being buried in a system prompt nobody sees. Read-only:
 * this reports what is in play, it does not configure anything.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { workspacePath } from './common/config.ts'
import { listProjects } from './common/project.ts'
import type { FlowConfig } from './common/types.ts'
import { loadStandards, standardsFor, type Standard } from './standards.ts'

export type Skill = {
  name: string
  description: string
  /**
   * The category this skill is scoped to: its frontmatter `categories`, or a
   * category its name starts with. Null for cross-cutting skills.
   */
  category: string | null
  /**
   * Whether that category matches the pinned project. A HINT, not a fact —
   * claude selects skills itself from their descriptions, so a skill with no
   * category match can still fire and one with a match may not.
   */
  matchesCategory: boolean
  /** How the agent gets it: engine auto-discovery, or this harness over MCP. */
  delivery: SkillDelivery
  /** Reference docs the skill ships alongside SKILL.md, with their sizes. */
  references: { file: string; bytes: number }[]
  /** Size of SKILL.md, so the UI can hint before fetching it. */
  bytes: number
}

/** One file's full text, fetched on demand. */
export type SkillFile = { file: string; body: string }

export type SkillDetail = {
  name: string
  /** SKILL.md in full, frontmatter stripped — the description is already listed. */
  body: string
  references: SkillFile[]
}

/** How a skill reaches the agent. */
export type SkillDelivery =
  /** Auto-loaded by the engine from its own discovery path (claude: .claude/skills). */
  | 'auto'
  /** Delivered by this harness over MCP — works for any engine. */
  | 'harness'

export type SkillsReport = {
  category: string | null
  repo: string | null
  skills: Skill[]
  /** Standards injected into agent prompts for this repo. Bodies are fetched
   * on demand — shipping all of them here was ~43KB on every pin change. */
  standards: { id: string; title: string; applies: string[]; bytes: number }[]
  /** Where the skills were read from, so the answer is checkable. */
  skillsRoot: string | null
}

/** Minimal frontmatter read — these files only carry `name` and `description`. */
function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  const out: Record<string, string> = {}
  // Values can wrap onto continuation lines, so accumulate until the next key.
  let key: string | null = null
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/)
    if (kv) {
      key = kv[1]
      out[key] = kv[2].trim()
    } else if (key && line.trim()) {
      out[key] += ` ${line.trim()}`
    }
  }
  return out
}

/** `[a, b]`, `a, b` or `a` → lowercased names. */
function parseList(v: string | undefined): string[] {
  if (!v) return []
  return v
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((x) =>
      x
        .trim()
        .replace(/^["']|["']$/g, '')
        .toLowerCase(),
    )
    .filter(Boolean)
}

/**
 * The categories a skill is scoped to. Taken from its frontmatter
 * `categories:` if present, else from a category name its own name starts with
 * (`frontend-guard` -> `frontend` when that category exists). Cross-cutting
 * skills get none and are never shown as mismatched.
 */
function skillCategories(fm: Record<string, string>, name: string, categories: string[]): string[] {
  const declared = parseList(fm.categories)
  if (declared.length) return declared
  const lower = name.toLowerCase()
  return categories.filter((c) => lower.startsWith(c))
}

/**
 * Skill directories, and how a skill found there reaches the agent.
 *
 * `.claude/skills` is claude's own project-level discovery path — those load
 * automatically, but only for claude. The shared skills dir is served by the
 * harness over MCP (list_skills / read_skill), which works the same for every
 * engine.
 */
const SKILL_SOURCES: { rel: (c: FlowConfig) => string[]; delivery: SkillDelivery }[] = [
  { rel: (c) => [c.skillsDir], delivery: 'harness' },
  { rel: () => ['.claude', 'skills'], delivery: 'auto' },
]

function sourceRoots(config: FlowConfig): { root: string; delivery: SkillDelivery }[] {
  if (!config.workspace) return []
  return SKILL_SOURCES.map((s) => ({
    root: path.join(config.workspace!, ...s.rel(config)),
    delivery: s.delivery,
  }))
}

export function skillsReport(
  config: FlowConfig,
  category?: string | null,
  repo?: string | null,
): SkillsReport {
  const skillsRoot = workspacePath(config, config.skillsDir)
  const skills: Skill[] = []
  const categoryNames = listProjects(config).map((c) => c.name.toLowerCase())

  for (const source of sourceRoots(config)) {
    const root = source.root
    if (!existsSync(root)) continue
    for (const name of readdirSync(root).sort()) {
      const file = path.join(root, name, 'SKILL.md')
      if (!existsSync(file)) continue
      let fm: Record<string, string> = {}
      try {
        fm = parseFrontmatter(readFileSync(file, 'utf8'))
      } catch {
        continue
      }
      const skillName = fm.name ?? name
      // A skill present in both roots is reported once, by whichever source
      // lists it first — the shared dir wins, since that is the set we serve.
      if (skills.some((s) => s.name === skillName)) continue
      const categories = skillCategories(fm, skillName, categoryNames)
      const skillCategory = categories[0] ?? null
      const refsDir = path.join(root, name, 'references')
      const references = existsSync(refsDir)
        ? readdirSync(refsDir)
            .filter((f) => f.endsWith('.md'))
            .sort()
            .map((f) => ({ file: f, bytes: statSync(path.join(refsDir, f)).size }))
        : []
      skills.push({
        name: skillName,
        description: fm.description ?? '',
        category: skillCategory,
        matchesCategory:
          !category || categories.length === 0 || categories.includes(category.toLowerCase()),
        delivery: source.delivery,
        references,
        bytes: statSync(file).size,
      })
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))

  const standards: Standard[] = standardsFor(config, category ?? undefined)
  return {
    category: category ?? null,
    repo: repo ?? null,
    skills,
    standards: standards.map((s) => ({
      id: s.id,
      title: s.title,
      applies: s.applies,
      bytes: Buffer.byteLength(s.body),
    })),
    skillsRoot,
  }
}

/**
 * One skill's full text: SKILL.md plus every reference it ships.
 *
 * `name` is checked against the actual directory listing rather than sanitised,
 * so a crafted value can only ever select a real skill — there is no path to
 * traverse out of. Returns null for anything not in that listing.
 */
export function readSkill(config: FlowConfig, name: string): SkillDetail | null {
  // Search both roots, checking the name against each real listing rather than
  // sanitising it — a crafted value can only ever select a skill that exists.
  let dir: string | null = null
  for (const source of sourceRoots(config)) {
    const root = source.root
    if (existsSync(root) && readdirSync(root).includes(name)) {
      dir = path.join(root, name)
      break
    }
  }
  if (!dir) return null
  const skillFile = path.join(dir, 'SKILL.md')
  if (!existsSync(skillFile)) return null

  // Drop the frontmatter — its description is already in the list payload.
  const raw = readFileSync(skillFile, 'utf8')
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()

  const refsDir = path.join(dir, 'references')
  const references: SkillFile[] = []
  if (existsSync(refsDir)) {
    for (const f of readdirSync(refsDir).sort()) {
      if (!f.endsWith('.md')) continue
      try {
        references.push({ file: f, body: readFileSync(path.join(refsDir, f), 'utf8').trim() })
      } catch {
        /* unreadable — omit rather than fail the whole skill */
      }
    }
  }
  return { name, body, references }
}

/** One standard's full text, by id. Null when there is no such standard. */
export function readStandard(
  config: FlowConfig,
  id: string,
): { id: string; title: string; body: string } | null {
  const match = loadStandards(config).find((s) => s.id === id)
  return match ? { id: match.id, title: match.title, body: match.body } : null
}
