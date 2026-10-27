/**
 * Per-repo code graphs via graphify (https://github.com/Graphify-Labs/graphify).
 *
 * graphify parses a repo with tree-sitter into a call/import/inherit graph —
 * deterministic, offline, no LLM — and answers `query` / `path` / `explain` /
 * `affected` against it. Agents that start from the graph read the handful of
 * files that matter instead of grepping and opening files one by one, which is
 * where most of a sub-agent's input tokens go on an unfamiliar repo.
 *
 * Footprint on the project repos is kept to nothing git sees: graphs live
 * under FLOW_HOME/graphs/<category>/<repo>/ (graphify's `--out`), and the
 * one file we must put in the repo — `.graphifyignore`, which keeps minified
 * vendor bundles under public/ out of the graph — is listed in the repo's own
 * `.git/info/exclude`, so `git status` stays clean.
 */
import { execFile, spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { homePath } from './common/home.ts'
import { listProjects, resolveRepoPath } from './common/project.ts'
import type { FlowConfig } from './common/types.ts'

const exec = promisify(execFile)

export type GraphKind = 'query' | 'path' | 'explain' | 'affected'

export type GraphStatus = {
  category: string
  repo: string
  /** graphify binary found on this machine. */
  installed: boolean
  /** A graph has been built for this repo. */
  built: boolean
  /** Path to graph.json when built. */
  graphPath: string | null
  nodes: number
  edges: number
  /** Build time, epoch ms. */
  builtAt: number | null
  /** A build is running right now. */
  building: boolean
  /** Tail of the last build log (success or failure). */
  lastLog: string
  lastError: string | null
}

/** Paths that make a code graph worse, not better: built/minified output and
 * third-party trees. gitignore syntax, anchored at the repo root. */
const IGNORE_PATTERNS = [
  '# written by Flow (codeGraph.ts): keep generated and vendor code out of the graph',
  'graphify-out/',
  'public/',
  'dist/',
  'build/',
  'vendor/',
  'storage/',
  'bootstrap/cache/',
  'node_modules/',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.lock',
  '*.svg',
]

const builds = new Map<string, { proc: ReturnType<typeof spawn>; log: string[] }>()
const lastLogs = new Map<string, { log: string; error: string | null }>()

let binCache: string | null | undefined

/** Where graphify is, or null when not installed. */
export function graphifyBin(): string | null {
  if (binCache !== undefined) return binCache
  const candidates = [
    process.env.GRAPHIFY_BIN,
    path.join(homedir(), '.local', 'bin', 'graphify'),
    '/usr/local/bin/graphify',
  ].filter((p): p is string => !!p)
  binCache = candidates.find((p) => existsSync(p)) ?? null
  return binCache
}

const key = (category: string, repo: string) => `${category.toLowerCase()}/${repo}`

/** graphify's `--out` dir; it writes `<dir>/graphify-out/graph.json`. */
export function graphOutDir(category: string, repo: string): string {
  return homePath('graphs', category.toLowerCase(), repo)
}

export function graphJsonPath(category: string, repo: string): string {
  return path.join(graphOutDir(category, repo), 'graphify-out', 'graph.json')
}

function countGraph(file: string): { nodes: number; edges: number } {
  try {
    const g = JSON.parse(readFileSync(file, 'utf8')) as { nodes?: unknown[]; links?: unknown[] }
    return { nodes: g.nodes?.length ?? 0, edges: g.links?.length ?? 0 }
  } catch {
    return { nodes: 0, edges: 0 }
  }
}

export function graphStatus(category: string, repo: string): GraphStatus {
  const file = graphJsonPath(category, repo)
  const built = existsSync(file)
  const counts = built ? countGraph(file) : { nodes: 0, edges: 0 }
  const k = key(category, repo)
  const last = lastLogs.get(k)
  const running = builds.get(k)
  return {
    category,
    repo,
    installed: !!graphifyBin(),
    built,
    graphPath: built ? file : null,
    nodes: counts.nodes,
    edges: counts.edges,
    builtAt: built ? statSync(file).mtimeMs : null,
    building: !!running,
    lastLog: running ? running.log.slice(-8).join('\n') : (last?.log ?? ''),
    lastError: last?.error ?? null,
  }
}

/**
 * Make sure the repo carries our `.graphifyignore`, hidden from git via
 * `.git/info/exclude`. Idempotent; a hand-edited ignore file is left alone.
 */
function ensureIgnore(repoPath: string) {
  const ignore = path.join(repoPath, '.graphifyignore')
  if (!existsSync(ignore)) writeFileSync(ignore, `${IGNORE_PATTERNS.join('\n')}\n`)
  const info = path.join(repoPath, '.git', 'info')
  if (!existsSync(path.join(repoPath, '.git'))) return
  mkdirSync(info, { recursive: true })
  const exclude = path.join(info, 'exclude')
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  const missing = ['.graphifyignore', 'graphify-out/'].filter(
    (line) => !current.split('\n').includes(line),
  )
  if (missing.length)
    appendFileSync(
      exclude,
      `${current.endsWith('\n') || !current ? '' : '\n'}${missing.join('\n')}\n`,
    )
}

/**
 * Build (or incrementally refresh) the repo's graph. Code only, no LLM, no
 * network: `graphify extract` skips files whose hash it already has, so a
 * rebuild after a small change is seconds. Resolves when the build exits.
 */
export function buildGraph(
  config: FlowConfig,
  category: string,
  repo: string,
  opts: { force?: boolean } = {},
): Promise<GraphStatus> {
  const bin = graphifyBin()
  if (!bin) throw new Error('graphify is not installed (uv tool install graphifyy)')
  const repoPath = resolveRepoPath(config, category, repo)
  if (!repoPath || !existsSync(repoPath)) throw new Error(`no such repo: ${category}/${repo}`)
  const k = key(category, repo)
  const running = builds.get(k)
  if (running) throw new Error(`a graph build for ${k} is already running`)

  ensureIgnore(repoPath)
  const out = graphOutDir(category, repo)
  mkdirSync(out, { recursive: true })
  const args = ['extract', repoPath, '--code-only', '--no-label', '--out', out]
  if (opts.force) args.push('--force')
  const log: string[] = []
  const proc = spawn(bin, args, {
    cwd: repoPath,
    env: { ...process.env, GRAPHIFY_BACKEND: 'none', GRAPHIFY_QUERY_LOG_DISABLE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  builds.set(k, { proc, log })
  const onData = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) if (line.trim()) log.push(line.trimEnd())
  }
  proc.stdout?.on('data', onData)
  proc.stderr?.on('data', onData)
  return new Promise((resolve, reject) => {
    proc.on('error', (e) => {
      builds.delete(k)
      lastLogs.set(k, { log: log.slice(-8).join('\n'), error: e.message })
      reject(e)
    })
    proc.on('exit', (code) => {
      builds.delete(k)
      const error = code === 0 ? null : `graphify extract exited ${code}`
      lastLogs.set(k, { log: log.slice(-8).join('\n'), error })
      if (error) reject(new Error(`${error}\n${log.slice(-10).join('\n')}`))
      else resolve(graphStatus(category, repo))
    })
  })
}

/** Progress of the one bulk build (buildGraphs) that may be running. */
const bulk = { running: false, total: 0, done: 0, current: null as string | null }

export function bulkStatus(): {
  running: boolean
  total: number
  done: number
  current: string | null
} {
  return { ...bulk }
}

/** Every category/repo in the workspace, with its graph status. */
export function allGraphStatuses(config: FlowConfig): GraphStatus[] {
  return listProjects(config).flatMap((c) => c.repos.map((r) => graphStatus(c.name, r)))
}

/**
 * Build graphs one after another: each build already uses every core, so
 * parallel builds only thrash. A target whose build is already running is
 * reported as failed rather than waited on. Never rejects; failures are listed.
 */
export async function buildGraphs(
  config: FlowConfig,
  targets: Array<{ category: string; repo: string }>,
  opts: { force?: boolean } = {},
): Promise<{ built: string[]; failed: Array<{ repo: string; error: string }> }> {
  const built: string[] = []
  const failed: Array<{ repo: string; error: string }> = []
  bulk.running = true
  bulk.total = targets.length
  bulk.done = 0
  bulk.current = null
  try {
    for (const t of targets) {
      const name = `${t.category}/${t.repo}`
      bulk.current = name
      if (builds.has(key(t.category, t.repo))) {
        failed.push({ repo: name, error: 'already building' })
      } else {
        try {
          await buildGraph(config, t.category, t.repo, opts)
          built.push(name)
        } catch (e) {
          const msg = (e as Error).message
          failed.push({ repo: name, error: msg.split('\n')[0] || msg })
        }
      }
      bulk.done++
    }
  } finally {
    bulk.running = false
    bulk.current = null
  }
  return { built, failed }
}

export type GraphAnswer = {
  kind: GraphKind
  /** graphify's text answer: nodes with file:line, relations, or candidates. */
  text: string
  /** 0 answered, 3 ambiguous (candidates listed), 4 no node matched. */
  exit: number
}

/**
 * Run one graphify read against the repo's graph. Output is graphify's own
 * text, which already cites file paths and line numbers, so an agent can go
 * straight to the right files.
 */
export async function askGraph(
  config: FlowConfig,
  category: string,
  repo: string,
  kind: GraphKind,
  input: {
    question?: string
    from?: string
    to?: string
    node?: string
    budget?: number
    depth?: number
  },
): Promise<GraphAnswer> {
  const bin = graphifyBin()
  if (!bin) throw new Error('graphify is not installed')
  const graph = graphJsonPath(category, repo)
  if (!existsSync(graph))
    throw new Error(`no graph built for ${category}/${repo}: run code_graph_build first`)
  const repoPath = resolveRepoPath(config, category, repo)!
  const args: string[] = []
  switch (kind) {
    case 'query':
      if (!input.question) throw new Error('query needs a question')
      args.push('query', input.question, '--budget', String(input.budget ?? 2000))
      break
    case 'path':
      if (!input.from || !input.to) throw new Error('path needs from and to')
      args.push('path', input.from, input.to)
      break
    case 'explain':
      if (!input.node) throw new Error('explain needs a node')
      args.push('explain', input.node)
      break
    case 'affected':
      if (!input.node) throw new Error('affected needs a node')
      args.push('affected', input.node, '--depth', String(input.depth ?? 2))
      break
  }
  args.push('--graph', graph)
  try {
    const { stdout, stderr } = await exec(bin, args, {
      cwd: repoPath,
      env: { ...process.env, GRAPHIFY_BACKEND: 'none', GRAPHIFY_QUERY_LOG_DISABLE: '1' },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60_000,
    })
    return { kind, text: (stdout + (stderr ? `\n${stderr}` : '')).trim(), exit: 0 }
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string; message: string }
    // 3 and 4 are answers ("ambiguous", "no match"), not failures.
    if (err.code === 3 || err.code === 4) {
      return { kind, text: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim(), exit: err.code }
    }
    throw new Error(`graphify ${kind} failed: ${err.stderr || err.message}`)
  }
}

/**
 * The paragraph a sub-agent gets when its repo has a graph: how to use it from
 * the shell, since sub-agents have no MCP. Empty when there is no graph.
 */
export function codeGraphPrompt(category?: string, repo?: string): string {
  if (!category || !repo || !graphifyBin()) return ''
  const graph = graphJsonPath(category, repo)
  if (!existsSync(graph)) return ''
  const bin = graphifyBin()
  return [
    'CODE GRAPH. This repo has a pre-built symbol graph (calls, imports, inherits; file:line',
    'on every node). Before grepping or opening files to find where something lives, ask the',
    'graph and then read only the files it names:',
    `  G=${graph}`,
    `  ${bin} query "<what you are looking for>" --graph $G`,
    `  ${bin} path "<A>" "<B>" --graph $G        # how A reaches B`,
    `  ${bin} explain "<Symbol>" --graph $G      # one node and its neighbours`,
    `  ${bin} affected "<Symbol>" --graph $G     # what depends on it`,
    'An ambiguous name lists candidates: retry with the id. "No node matching" = fall back',
    'to grep. The graph is code only and was built before your task: it does not know edits',
    'you make, config arrays, Blade templates or lang keys.',
  ].join('\n')
}
