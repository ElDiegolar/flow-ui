/**
 * The daemon's own connections to the external MCP servers (Atlassian, Figma).
 *
 * Why the daemon holds them, not the orchestrator
 * -----------------------------------------------
 * The orchestrator used to declare `atlassian` in its own --mcp-config, so every
 * orchestrator start — and every task switch restarts it — spawned a fresh
 * `npx mcp-remote`. When that process has no token for its URL it opens a
 * browser OAuth window. Sub-agents inherited the developer's user-scope
 * `atlassian` server too. Result: a login popup per restart, per agent, and
 * (because the old bridge pointed at /v1/sse while the developer had authenticated
 * /v1/mcp) logins that never stuck.
 *
 * Now there is exactly ONE connection per server per daemon process. Agents
 * reach it through Flow's own MCP tools (jira_call / figma_call), so an
 * orchestrator restart touches nothing here.
 *
 * The popup rule
 * --------------
 * mcp-remote opens a browser whenever it has no usable token. So the daemon only
 * connects to Atlassian on its own when a token for the configured URL is
 * already cached (a no-popup reconnect), and at most AUTO_ATTEMPTS times per
 * session. Anything else waits for the developer to press Connect in Setup —
 * the one place a login window is expected. Concurrent callers share one
 * in-flight attempt, so two requests can never open two windows.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { publish } from '../common/bus.ts'
import { getSettings } from '../settings.ts'

export type ServerName = 'atlassian' | 'figma'

export type ConnState =
  /** Turned off in settings. */
  | 'disabled'
  /** Not connected; nothing is stopping a connect. */
  | 'idle'
  /** No cached login for this URL — needs a manual Connect (opens a browser once). */
  | 'needs-auth'
  | 'connecting'
  | 'connected'
  | 'error'

export type ServerStatus = {
  name: ServerName
  state: ConnState
  url: string
  detail: string
  /** Atlassian only: a token for `url` is cached, so connecting will not prompt. */
  tokenCached: boolean | null
  /** Where the cached token lives — checkable rather than magic. */
  tokenFile: string | null
  /** The login URL mcp-remote printed, while it waits on the developer. */
  authUrl: string | null
  tools: string[]
  connectedAt: number | null
}

type Conn = {
  client: Client | null
  transport: Transport | null
  state: ConnState
  detail: string
  authUrl: string | null
  tools: string[]
  connectedAt: number | null
  /** The URL the live client was opened against — a settings change invalidates it. */
  url: string | null
  inflight: Promise<void> | null
}

const conns: Record<ServerName, Conn> = {
  atlassian: blank(),
  figma: blank(),
}

function blank(): Conn {
  return {
    client: null,
    transport: null,
    state: 'idle',
    detail: 'Not connected.',
    authUrl: null,
    tools: [],
    connectedAt: null,
    url: null,
    inflight: null,
  }
}

/** Unattended Atlassian connects allowed per daemon session. */
const AUTO_ATTEMPTS = 3
let autoAttempts = 0

const CONNECT_TIMEOUT_MS = 60_000
/** A manual connect waits on a human in a browser — give them time. */
const MANUAL_CONNECT_TIMEOUT_MS = 5 * 60_000

/**
 * mcp-remote caches OAuth under ~/.mcp-auth/mcp-remote-<version>/ as
 * `<md5(serverUrl)>_tokens.json`. The hash is what matters: a token for
 * /v1/mcp does nothing for /v1/sse, which is exactly the mismatch the old
 * any-token-file check could not see. `.bak.*` / `.cleared.*` dirs are dead
 * copies it leaves behind and must not count.
 */
export function cachedAtlassianToken(url: string): string | null {
  const root = path.join(homedir(), '.mcp-auth')
  if (!existsSync(root)) return null
  const hash = createHash('md5').update(url).digest('hex')
  let dirs: string[]
  try {
    dirs = readdirSync(root)
  } catch {
    return null
  }
  for (const d of dirs) {
    if (!d.startsWith('mcp-remote-') || d.includes('.bak.') || d.includes('.cleared.')) continue
    const file = path.join(root, d, `${hash}_tokens.json`)
    try {
      // An empty file is a half-finished login.
      if (statSync(file).size > 2) return file
    } catch {
      /* not in this version dir */
    }
  }
  return null
}

function urlFor(name: ServerName): string {
  const s = getSettings()
  return name === 'atlassian' ? s.atlassian.url : s.figma.url
}

function enabled(name: ServerName): boolean {
  const s = getSettings()
  return name === 'atlassian' ? s.atlassian.enabled : s.figma.enabled
}

export function serverStatus(name: ServerName): ServerStatus {
  const c = conns[name]
  const url = urlFor(name)
  const tokenFile = name === 'atlassian' ? cachedAtlassianToken(url) : null
  let state = c.state
  let detail = c.detail
  if (!enabled(name)) {
    state = 'disabled'
    detail = 'Turned off in Setup.'
  } else if (state === 'idle' && name === 'atlassian' && !tokenFile) {
    state = 'needs-auth'
    detail = 'No cached login for this URL. Press Connect to sign in once.'
  } else if (state === 'connected' && c.url !== url) {
    state = 'idle'
    detail = 'URL changed in Setup — reconnect to use the new one.'
  }
  return {
    name,
    state,
    url,
    detail,
    tokenCached: name === 'atlassian' ? tokenFile !== null : null,
    tokenFile,
    authUrl: c.authUrl,
    tools: c.tools,
    connectedAt: c.connectedAt,
  }
}

export function hubStatus(): Record<ServerName, ServerStatus> {
  return { atlassian: serverStatus('atlassian'), figma: serverStatus('figma') }
}

function makeTransport(name: ServerName, url: string, conn: Conn): Transport {
  if (name === 'figma') return new StreamableHTTPClientTransport(new URL(url))
  // mcp-remote bridges the remote server to stdio and owns the OAuth dance.
  const t = new StdioClientTransport({
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['-y', 'mcp-remote', url],
    env: { ...(process.env as Record<string, string>) },
    stderr: 'pipe',
  })
  // Surface mcp-remote's own progress — in particular the login URL, so the
  // Setup tab can show it if the browser window was missed or blocked.
  t.stderr?.on('data', (buf: Buffer) => {
    const text = buf.toString()
    const m = text.match(/https:\/\/\S*(?:authorize|oauth)\S*/i)
    if (m) {
      conn.authUrl = m[0]
      conn.detail = 'Waiting for you to finish signing in in the browser…'
    }
  })
  return t
}

/** Tell the UI a connection moved (it re-reads /api/integrations for detail). */
function announce() {
  publish({ type: 'integrations', status: hubStatus() })
}

async function open(name: ServerName, timeoutMs: number): Promise<void> {
  const conn = conns[name]
  const url = urlFor(name)
  await closeConn(name)
  conn.state = 'connecting'
  conn.detail = name === 'atlassian' ? 'Starting mcp-remote…' : 'Connecting to Figma Desktop…'
  conn.authUrl = null
  announce()
  const transport = makeTransport(name, url, conn)
  const client = new Client({ name: 'flow', version: '0.1.0' })
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out connecting')), timeoutMs)
      }),
    ])
    const { tools } = await client.listTools()
    conn.client = client
    conn.transport = transport
    conn.url = url
    conn.state = 'connected'
    conn.detail = `Connected — ${tools.length} tools.`
    conn.tools = tools.map((t) => t.name).sort()
    conn.connectedAt = Date.now()
    conn.authUrl = null
    // The server going away (mcp-remote exiting, Figma quitting) drops us back
    // to idle; the next call decides whether a quiet reconnect is allowed.
    transport.onclose = () => {
      if (conn.transport !== transport) return
      conn.client = null
      conn.transport = null
      conn.state = 'idle'
      conn.detail = 'Connection closed.'
      conn.connectedAt = null
      announce()
    }
    announce()
  } catch (e) {
    try {
      await client.close()
    } catch {
      /* already down */
    }
    conn.state = 'error'
    conn.detail =
      name === 'figma'
        ? `Figma Desktop is not reachable at ${url} — open it and enable its MCP server.`
        : `Could not connect: ${(e as Error).message}`
    announce()
    throw e
  } finally {
    clearTimeout(timer)
  }
}

async function closeConn(name: ServerName) {
  const conn = conns[name]
  const client = conn.client
  conn.client = null
  conn.transport = null
  conn.tools = []
  conn.connectedAt = null
  if (client) {
    try {
      await client.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Connect a server. `manual` means the developer asked (Setup → Connect), which
 * is the only way Atlassian is allowed to open a login window.
 */
export async function connect(name: ServerName, manual: boolean): Promise<ServerStatus> {
  const conn = conns[name]
  if (!enabled(name)) return serverStatus(name)
  if (conn.inflight) {
    await conn.inflight.catch(() => {})
    return serverStatus(name)
  }
  if (name === 'atlassian' && !manual) {
    if (!cachedAtlassianToken(urlFor(name))) return serverStatus(name)
    if (autoAttempts >= AUTO_ATTEMPTS) {
      conn.state = 'error'
      conn.detail = 'Dropped too many times this session — press Connect to retry.'
      return serverStatus(name)
    }
    autoAttempts++
  }
  conn.inflight = open(name, manual ? MANUAL_CONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS)
  try {
    await conn.inflight
  } catch {
    /* state/detail already record it */
  } finally {
    conn.inflight = null
  }
  return serverStatus(name)
}

export async function disconnect(name: ServerName): Promise<ServerStatus> {
  await closeConn(name)
  conns[name].state = 'idle'
  conns[name].detail = 'Disconnected.'
  return serverStatus(name)
}

/**
 * Setup → Reset: disconnect, and for Atlassian move this URL's cached login
 * aside so the next Connect signs in from scratch. Moved, not deleted — into a
 * `.cleared.<ts>` sibling, the same convention mcp-remote itself uses — so a
 * reset by mistake is recoverable. Also re-arms the auto-connect budget.
 */
export async function resetServer(
  name: ServerName,
): Promise<ServerStatus & { movedAside: string[] }> {
  await closeConn(name)
  const conn = conns[name]
  conn.state = 'idle'
  conn.detail = 'Reset — press Connect to sign in again.'
  conn.authUrl = null
  const movedAside: string[] = []
  if (name === 'atlassian') {
    autoAttempts = 0
    const hash = createHash('md5').update(urlFor(name)).digest('hex')
    const root = path.join(homedir(), '.mcp-auth')
    let dirs: string[] = []
    try {
      dirs = readdirSync(root)
    } catch {
      /* nothing cached */
    }
    for (const d of dirs) {
      if (!d.startsWith('mcp-remote-') || d.includes('.bak.') || d.includes('.cleared.')) continue
      const dir = path.join(root, d)
      let files: string[] = []
      try {
        files = readdirSync(dir).filter((f) => f.startsWith(`${hash}_`))
      } catch {
        continue
      }
      if (!files.length) continue
      const aside = path.join(root, `${d}.cleared.${Date.now()}`)
      mkdirSync(aside, { recursive: true })
      for (const f of files) {
        renameSync(path.join(dir, f), path.join(aside, f))
        movedAside.push(path.join(aside, f))
      }
    }
  }
  return { ...serverStatus(name), movedAside }
}

/** A live client, quietly (re)connecting when that cannot open a login window. */
async function ensure(name: ServerName): Promise<Client> {
  if (!enabled(name)) throw new Error(`${name} is turned off in Setup.`)
  const conn = conns[name]
  if (conn.client && conn.url === urlFor(name)) return conn.client
  await connect(name, false)
  if (conn.client) return conn.client
  const st = serverStatus(name)
  throw new Error(
    name === 'atlassian'
      ? `Jira is not connected (${st.detail}) Ask the developer to press Connect under Setup → Atlassian.`
      : st.detail,
  )
}

export type ToolResult = {
  content: Array<Record<string, unknown> & { type: string }>
  isError?: boolean
  structuredContent?: unknown
}

export async function callTool(
  name: ServerName,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const client = await ensure(name)
  return (await client.callTool({ name: tool, arguments: args })) as ToolResult
}

/** Tool names + descriptions + input schemas, for agents that need to pick one. */
export async function listTools(name: ServerName) {
  const client = await ensure(name)
  const { tools } = await client.listTools()
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
}

/**
 * Parse the JSON an Atlassian tool returns. Its results arrive as text content
 * holding a JSON document; anything else is handed back as the raw text.
 */
export function toolJson(result: ToolResult): unknown {
  const text = result.content
    .filter((c) => c.type === 'text')
    .map((c) => String(c.text ?? ''))
    .join('\n')
  if (result.isError) throw new Error(text || 'tool returned an error')
  if (result.structuredContent !== undefined) return result.structuredContent
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Startup: one quiet Atlassian connect if a login is already cached. Never prompts. */
export function autoConnectOnBoot() {
  const s = getSettings()
  if (s.atlassian.enabled && s.atlassian.autoConnect) void connect('atlassian', false)
}

export async function shutdownHub() {
  await Promise.all([closeConn('atlassian'), closeConn('figma')])
}
