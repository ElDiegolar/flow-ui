/**
 * Session lifecycle: spawn, list, replay, wait, type into, and kill.
 */
import type { FastifyInstance } from 'fastify'
import {
  getSession,
  killSession,
  listSessions,
  waitForSession,
  writeToSession,
  type WaitUntil,
} from '../pty.ts'
import { SessionRequestError, spawnCommandSession, type SpawnBody } from '../sessions.ts'
import { sessionText } from '../sessionText.ts'
import type { Session } from '../pty.ts'
import type { RouteContext } from './context.ts'

/** `?view=text&since=N`: the agent-facing read (see sessionText.ts). */
type TextQuery = { view?: 'text'; since?: string }

async function agentView(s: Session, since?: string) {
  const t = await sessionText(s, Number(since) || 0)
  return {
    exited: s.exited,
    exitCode: s.exitCode,
    awaitingInput: s.awaitingInput,
    awaitReason: s.awaitReason,
    ...t,
  }
}

export function registerSessionRoutes(scope: FastifyInstance, ctx: RouteContext) {
  scope.get('/api/sessions', async () => ({ sessions: listSessions() }))

  // in sessions.ts (`spawnCommandSession`) so the resume flow can reuse it.
  scope.post<{ Body: SpawnBody }>('/api/sessions', async (req, reply) => {
    try {
      return spawnCommandSession(ctx.config, req.body)
    } catch (err) {
      if (err instanceof SessionRequestError) {
        reply.code(err.status)
        return { error: err.message }
      }
      throw err
    }
  })

  scope.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const ok = killSession(req.params.id)
    if (!ok) {
      reply.code(404)
      return { error: 'session not found or already exited' }
    }
    return { ok: true }
  })

  // Type into a running session's PTY (the orchestrator drives sub-agents
  // through this via the send_input MCP tool; also used by the UI).
  scope.post<{
    Params: { id: string }
    Body: { text?: string; enter?: boolean; bracketedPaste?: boolean }
  }>('/api/sessions/:id/input', async (req, reply) => {
    const { text, enter, bracketedPaste } = req.body ?? {}
    if (typeof text !== 'string' || text.length === 0) {
      reply.code(400)
      return { error: 'text required' }
    }
    const ok = writeToSession(req.params.id, text, { enter, bracketedPaste })
    if (!ok) {
      reply.code(404)
      return { error: 'session not found or already exited' }
    }
    return { ok: true }
  })

  scope.get<{ Params: { id: string }; Querystring: TextQuery }>(
    '/api/sessions/:id/replay',
    async (req, reply) => {
      const s = getSession(req.params.id)
      if (!s) {
        reply.code(404)
        return { error: 'not found' }
      }
      if (req.query.view === 'text') return agentView(s, req.query.since)
      return {
        id: s.id,
        label: s.invocation.label,
        output: s.output,
        exited: s.exited,
        exitCode: s.exitCode,
        // Surfaced so a driver (the orchestrator's read_session loop) can tell a
        // sub-agent that is blocked waiting for input apart from one still working.
        awaitingInput: s.awaitingInput,
        awaitReason: s.awaitReason,
      }
    },
  )

  // Long-poll: hold the request open until the session exits (or blocks on
  // input), then return the same payload /replay would. This is what the
  // orchestrator calls instead of spinning read_session — one round trip
  // instead of one inference turn per poll.
  scope.post<{
    Params: { id: string }
    Querystring: TextQuery
    Body: { timeoutMs?: number; until?: WaitUntil }
  }>('/api/sessions/:id/wait', async (req, reply) => {
    const { timeoutMs, until } = req.body ?? {}
    if (until && until !== 'exit' && until !== 'exit-or-input') {
      reply.code(400)
      return { error: 'until must be "exit" or "exit-or-input"' }
    }
    const pending = waitForSession(req.params.id, { timeoutMs, until })
    if (!pending) {
      reply.code(404)
      return { error: 'not found' }
    }
    const outcome = await pending
    const s = getSession(req.params.id)
    if (!s) {
      reply.code(404)
      return { error: 'not found' }
    }
    if (req.query.view === 'text') return { outcome, ...(await agentView(s, req.query.since)) }
    return {
      id: s.id,
      label: s.invocation.label,
      outcome,
      output: s.output,
      exited: s.exited,
      exitCode: s.exitCode,
      awaitingInput: s.awaitingInput,
      awaitReason: s.awaitReason,
    }
  })
}
