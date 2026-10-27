/**
 * Per-repo code graphs (codeGraph.ts): status, build, and the four graphify
 * reads the orchestrator's code_graph_* tools go through.
 */
import type { FastifyInstance } from 'fastify'
import { publish } from '../common/bus.ts'
import { listProjects } from '../common/project.ts'
import {
  allGraphStatuses,
  askGraph,
  buildGraph,
  buildGraphs,
  bulkStatus,
  graphStatus,
  graphifyBin,
  type GraphKind,
} from '../codeGraph.ts'
import type { RouteContext } from './context.ts'

const KINDS: GraphKind[] = ['query', 'path', 'explain', 'affected']

export function registerCodeGraphRoutes(scope: FastifyInstance, ctx: RouteContext) {
  // No params: every graph in the workspace plus bulk progress. Both params:
  // one repo. Only one of them is ambiguous, so it is refused.
  scope.get<{ Querystring: { category?: string; repo?: string } }>(
    '/api/code-graph/status',
    async (req, reply) => {
      const { category, repo } = req.query
      if (!category && !repo) return { bulk: bulkStatus(), graphs: allGraphStatuses(ctx.config) }
      if (!category || !repo) {
        reply.code(400)
        return { error: 'give both category and repo, or neither for every graph' }
      }
      return graphStatus(category, repo)
    },
  )

  // Kicks the build off and returns at once; the finished status is published
  // on the bus and readable via /status. A build takes seconds (incremental)
  // to a few minutes (first run on a large repo).
  scope.post<{ Body: { category?: string; repo?: string; all?: boolean; force?: boolean } }>(
    '/api/code-graph/build',
    async (req, reply) => {
      const { category, repo, all, force } = req.body ?? {}
      if (!repo && !category && !all) {
        reply.code(400)
        return { error: 'give category and repo, category alone, or all: true' }
      }
      if (repo && !category) {
        reply.code(400)
        return { error: 'repo needs a category' }
      }
      if (!graphifyBin()) {
        reply.code(409)
        return { error: 'graphify is not installed: uv tool install graphifyy' }
      }

      // Single repo: the original form, returns the status of that graph.
      if (category && repo) {
        const announce = () => publish({ type: 'code-graph', status: graphStatus(category, repo) })
        try {
          const done = buildGraph(ctx.config, category, repo, { force })
          done.then(announce, announce)
          announce()
          return { started: true, status: graphStatus(category, repo) }
        } catch (e) {
          reply.code(400)
          return { error: (e as Error).message }
        }
      }

      // Bulk: a whole category, or every repo in every category.
      if (bulkStatus().running) {
        reply.code(409)
        return { error: 'a bulk graph build is already running', bulk: bulkStatus() }
      }
      const projects = listProjects(ctx.config)
      let targets: Array<{ category: string; repo: string }>
      if (all) {
        targets = projects.flatMap((c) => c.repos.map((r) => ({ category: c.name, repo: r })))
      } else {
        const wanted = category!.toLowerCase()
        const project = projects.find((c) => c.name.toLowerCase() === wanted)
        if (!project) {
          reply.code(404)
          return { error: `no such category: ${category}` }
        }
        targets = project.repos.map((r) => ({ category: project.name, repo: r }))
      }
      if (targets.length === 0) {
        reply.code(400)
        return { error: 'no repos to build' }
      }
      const names = targets.map((t) => `${t.category}/${t.repo}`)
      void buildGraphs(ctx.config, targets, { force }).then((result) =>
        publish({ type: 'code-graph', status: { bulk: bulkStatus(), ...result } }),
      )
      return { started: true, targets: names, bulk: bulkStatus() }
    },
  )

  scope.post<{
    Body: {
      category?: string
      repo?: string
      kind?: GraphKind
      question?: string
      from?: string
      to?: string
      node?: string
      budget?: number
      depth?: number
    }
  }>('/api/code-graph/ask', async (req, reply) => {
    const { category, repo, kind, ...input } = req.body ?? {}
    if (!category || !repo || !kind || !KINDS.includes(kind)) {
      reply.code(400)
      return { error: `category, repo and kind (${KINDS.join('|')}) are required` }
    }
    try {
      return await askGraph(ctx.config, category, repo, kind, input)
    } catch (e) {
      reply.code(400)
      return { error: (e as Error).message }
    }
  })
}
