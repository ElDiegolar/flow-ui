/**
 * Daemon entrypoint: build the Fastify app, register each route group, and own
 * the process-level lifecycle (listen, banner, periodic snapshots, shutdown).
 *
 * The routes themselves live in `routes/<domain>.ts`, one group per domain.
 * Anything added here should be
 * bootstrap or lifecycle — a new endpoint belongs in its domain's route file.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import { initToken, requireToken } from './auth.ts'
import { getConfig, setCliWorkspace } from './common/config.ts'
import { getSession, onSessionEvent, listSessions } from './pty.ts'
import { orchestratorId } from './orchestrator/index.ts'
import { parkTask, parkedManifest } from './park.ts'
import { listTasks, updateTask } from './tasks.ts'
import { refreshRemotes } from './sync.ts'
import { onAppEvent } from './common/bus.ts'
import { activeContext, watchContext } from './context.ts'
import { autoConnectOnBoot, shutdownHub } from './integrations/hub.ts'
import { startBoardSyncTimer } from './integrations/jiraBoard.ts'
import type { RouteContext } from './routes/context.ts'
import { registerCodeGraphRoutes } from './routes/codeGraph.ts'
import { registerCommandRoutes } from './routes/commands.ts'
import { registerAiSetupRoutes } from './routes/aiSetup.ts'
import { registerGitRoutes } from './routes/git.ts'
import { registerIntegrationRoutes } from './routes/integrations.ts'
import { registerJiraRoutes } from './routes/jira.ts'
import { registerLearningRoutes } from './routes/learnings.ts'
import { registerOrchestratorRoutes } from './routes/orchestrator.ts'
import { registerPasteRoutes } from './routes/paste.ts'
import { registerProjectRoutes } from './routes/projects.ts'
import { registerSessionRoutes } from './routes/sessions.ts'
import { registerSettingsRoutes } from './routes/settings.ts'
import { registerSetupRoutes } from './routes/setup.ts'
import { registerSkillRoutes } from './routes/skills.ts'
import { registerSyncRoutes } from './routes/sync.ts'
import { registerTaskRoutes } from './routes/tasks.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT ?? 8765)
const HOST = process.env.HOST ?? '127.0.0.1'
// URL the orchestrator's MCP server uses to call back into this daemon. The
// MCP server runs on the same host, so a loopback address is always reachable.
const DAEMON_URL = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`

// --workspace <path> wins over discovery; FLOW_WORKSPACE wins over both.
const cliWorkspaceIdx = process.argv.indexOf('--workspace')
setCliWorkspace(cliWorkspaceIdx > 0 ? process.argv[cliWorkspaceIdx + 1] : undefined)
const token = initToken()
// A getter, not a snapshot: AI Setup reloads the config and routes must see it.
const ctx: RouteContext = {
  get config() {
    return getConfig()
  },
  token,
  daemonUrl: DAEMON_URL,
}

// 30 MB body limit so pasted images (sent as base64) fit; everything else is tiny.
const app = Fastify({ logger: false, bodyLimit: 30 * 1024 * 1024 })
await app.register(fastifyWebsocket)

const webDist = path.resolve(__dirname, '..', '..', 'web', 'dist')
const WEB_PORT = Number(process.env.WEB_PORT ?? 5180)
// web/dist is gitignored, so a fresh clone has no built UI to serve here — the
// page comes from Vite (`npm run dev`) on WEB_PORT. Without this, the banner's
// link to this port was a bare 404 for anyone who hadn't run `npm run build`.
const uiBuilt = existsSync(webDist)
const webUrl = `http://127.0.0.1:${WEB_PORT}`
if (uiBuilt) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/' })
} else {
  app.get('/', async (req, reply) => {
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
    const viteUp = await fetch(webUrl, { signal: AbortSignal.timeout(800) })
      .then(() => true)
      .catch(() => false)
    if (viteUp) return reply.redirect(`${webUrl}/${query}`)
    reply.type('text/html').code(503)
    return (
      '<!doctype html><title>Flow</title><body style="font:15px system-ui;margin:3rem;max-width:40rem">' +
      '<h1>The web UI is not running</h1>' +
      '<p>This is the daemon. The UI is not built, so it is served by Vite on port ' +
      `${WEB_PORT}, which is not answering.</p><ul>` +
      '<li>Run <code>npm run dev</code> (daemon + UI) and open the <b>Open:</b> link it prints, or</li>' +
      '<li>run <code>npm run build</code> once, and this page serves the UI itself.</li></ul></body>'
    )
  })
}

// Health + bootstrap (token gating exempt) ---------------------------------
app.get('/api/health', async () => ({
  ok: true,
  workspace: getConfig().workspace,
  workspaceName: getConfig().workspace ? getConfig().name : null,
}))

app.get('/api/auth/bootstrap', async (req) => {
  // Bootstrap endpoint accepts the token via query string only; once the SPA
  // grabs it, every subsequent request must use the X-Flow-Token header.
  const provided = (req.query as { token?: string })?.token
  if (provided !== token) return { authenticated: false }
  return { authenticated: true, token }
})

// Token-gated API ----------------------------------------------------------
app.register(async (scope) => {
  scope.addHook('onRequest', requireToken)

  registerProjectRoutes(scope, ctx)
  registerSessionRoutes(scope, ctx)
  registerOrchestratorRoutes(scope, ctx)
  registerTaskRoutes(scope, ctx)
  registerSyncRoutes(scope, ctx)
  registerSettingsRoutes(scope)
  registerSetupRoutes(scope, ctx)
  registerAiSetupRoutes(scope, ctx)
  registerSkillRoutes(scope, ctx)
  registerJiraRoutes(scope)
  registerIntegrationRoutes(scope, ctx)
  registerLearningRoutes(scope)
  registerCodeGraphRoutes(scope, ctx)
  registerCommandRoutes(scope, ctx)
  registerGitRoutes(scope, ctx)
  registerPasteRoutes(scope)
})

// WebSocket: streaming PTY output ------------------------------------------
app.register(async (scope) => {
  scope.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/api/sessions/:id/stream',
    { websocket: true },
    (socket, req) => {
      // @fastify/websocket v10 hands the raw WebSocket as the first arg
      // (older versions wrapped it in `{ socket }`).
      const provided = req.query?.token
      if (provided !== token) {
        socket.send(JSON.stringify({ type: 'error', message: 'unauthorized' }))
        socket.close()
        return
      }
      const session = getSession(req.params.id)
      if (!session) {
        socket.send(JSON.stringify({ type: 'error', message: 'not found' }))
        socket.close()
        return
      }

      // Replay anything that has already been emitted, then live stream.
      if (session.output) {
        socket.send(JSON.stringify({ type: 'data', data: session.output }))
      }

      const onData = (data: string) => {
        socket.send(JSON.stringify({ type: 'data', data }))
      }
      const onExit = (exitCode: number) => {
        socket.send(JSON.stringify({ type: 'exit', exitCode }))
      }

      session.listeners.add(onData)
      session.exitListeners.add(onExit)

      if (session.exited) {
        socket.send(JSON.stringify({ type: 'exit', exitCode: session.exitCode ?? 0 }))
      }

      socket.on('message', (raw: Buffer) => {
        // Client can send raw input keys (Ctrl-C, manual typing) to the PTY.
        try {
          const msg = JSON.parse(raw.toString())
          if (msg.type === 'input' && typeof msg.data === 'string') {
            session.pty.write(msg.data)
          } else if (msg.type === 'resize' && msg.cols && msg.rows) {
            session.pty.resize(msg.cols, msg.rows)
          }
        } catch {
          // Ignore malformed input
        }
      })

      socket.on('close', () => {
        session.listeners.delete(onData)
        session.exitListeners.delete(onExit)
      })
    },
  )

  // Global session-lifecycle feed: pushes a snapshot of all sessions on connect,
  // then live { session-created | session-updated | session-exited } events so
  // the UI can show subagents being spun up in real time.
  scope.get<{ Querystring: { token?: string } }>(
    '/api/events',
    { websocket: true },
    (socket, req) => {
      if (req.query?.token !== token) {
        socket.send(JSON.stringify({ type: 'error', message: 'unauthorized' }))
        socket.close()
        return
      }
      // Snapshot first so a late subscriber sees current state; the client keys
      // by session id and upserts, so a create racing the snapshot is harmless.
      socket.send(JSON.stringify({ type: 'snapshot', sessions: listSessions() }))
      // App-level events ride the same socket: the active context, board syncs,
      // integration state. The context goes first so a fresh tab starts right.
      socket.send(JSON.stringify({ type: 'context', context: activeContext() }))
      const offSessions = onSessionEvent((e) => socket.send(JSON.stringify(e)))
      const offApp = onAppEvent((e) => socket.send(JSON.stringify(e)))
      socket.on('close', () => {
        offSessions()
        offApp()
      })
    },
  )
})

await app.listen({ host: HOST, port: PORT })

const url = uiBuilt ? `http://${HOST}:${PORT}/?token=${token}` : `${webUrl}/?token=${token}`
console.log('\n┌────────────────────────────────────────────────────┐')
console.log('│  Flow daemon                                       │')
console.log('├────────────────────────────────────────────────────┤')
const cfg = getConfig()
console.log(`│  Workspace:    ${cfg.workspace ?? 'none — open Setup to create one'}`)
console.log(`│  Claude bin:   ${cfg.claudeBin}`)
console.log(`│  Listening on: http://${HOST}:${PORT}`)
console.log(`│  Open:         ${url}`)
if (!uiBuilt)
  console.log(
    `│  (UI served by Vite on :${WEB_PORT} — run \`npm run build\` to serve it on :${PORT} too)`,
  )
console.log('└────────────────────────────────────────────────────┘\n')

// Boot reconciliation: PTYs don't survive a restart, so any task left
// 'in_progress' from a previous run is stale. If it has a parked snapshot on
// disk, mark it 'parked' (resumable); otherwise leave it for the user.
for (const t of listTasks()) {
  if (t.status === 'in_progress' && parkedManifest(t.id)) {
    updateTask(t.id, { status: 'parked' })
  }
}

// Periodic snapshot of the active task's scrollback so a daemon restart (crash,
// deploy, or dev hot-reload) leaves a resumable manifest. parkTask(…, false)
// writes the manifest + history logs without killing the live processes.
function snapshotActiveTask() {
  const oid = orchestratorId()
  if (!oid) return
  const active = listTasks().find((t) => t.status === 'in_progress' && t.sessionIds.includes(oid))
  if (active) {
    try {
      parkTask(getConfig(), active.id, false)
    } catch {
      /* best-effort */
    }
  }
}
const snapshotTimer = setInterval(snapshotActiveTask, 10_000)
snapshotTimer.unref?.()

// Keep remote-tracking refs warm so /api/sync answers are recent without any
// request paying for the network. Fetching every repo is the expensive half of
// the sync check, so it runs on a slow timer rather than per request.
const SYNC_REFRESH_MS = Number(process.env.FLOW_SYNC_REFRESH_MS ?? 10 * 60 * 1000)
// 0 disables remote refresh entirely — used by the e2e suite so a test run
// never depends on the network.
if (SYNC_REFRESH_MS > 0) {
  void refreshRemotes(getConfig())
  const syncTimer = setInterval(() => void refreshRemotes(getConfig()), SYNC_REFRESH_MS)
  syncTimer.unref?.()
}

// The active context (pinned repo + live branch) — every tab follows it.
watchContext()

// External MCP servers: one connection each for the whole daemon session. A
// quiet Atlassian connect happens only when a login is already cached — a
// restart never opens a browser (integrations/hub.ts). The board then syncs
// itself on the configured interval while that connection is up.
autoConnectOnBoot()
startBoardSyncTimer()

process.on('SIGINT', async () => {
  snapshotActiveTask()
  await shutdownHub()
  await app.close()
  process.exit(0)
})
