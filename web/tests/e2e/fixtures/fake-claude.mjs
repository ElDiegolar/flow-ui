#!/usr/bin/env node
/**
 * Deterministic stand-in for the `claude` binary, used by the orchestrator
 * full-flow e2e test (wired in via CLAUDE_BIN). It ignores the claude CLI flags
 * passed by buildOrchestratorInvocation and instead provides a tiny, scriptable
 * REPL so the test can exercise the real plumbing we own:
 *
 *   - PTY spawn + live output streaming to the browser terminal
 *   - browser keyboard input flowing back over the WebSocket into this stdin
 *   - the orchestrator's env-injected callback path to the daemon API
 *     (FLOW_URL / FLOW_TOKEN) — the same channel the real MCP
 *     server uses
 *   - a simulated permission-prompt round trip (output → input → output)
 *
 * Commands (one per line):
 *   mcp-check     → GET {FLOW_URL}/api/projects, print MCP-OK <n> / MCP-ERR
 *   commit-check → print a permission prompt; next line "y" → APPROVED, else DENIED
 *   exit          → quit
 *   <anything>    → echo: <line>
 */
process.stdout.write('FAKE-CLAUDE READY\r\n> ')

let buf = ''
let awaitingApproval = false

async function handleLine(line) {
  const cmd = line.trim()
  if (!cmd) return

  if (awaitingApproval) {
    awaitingApproval = false
    process.stdout.write(
      /^y(es)?$/i.test(cmd) ? 'APPROVED git_commit\r\n> ' : 'DENIED git_commit\r\n> ',
    )
    return
  }

  if (cmd === 'exit') {
    process.stdout.write('bye\r\n')
    process.exit(0)
  }

  if (cmd.includes('mcp-check')) {
    const base = process.env.FLOW_URL ?? ''
    const token = process.env.FLOW_TOKEN ?? ''
    try {
      const res = await fetch(`${base}/api/projects`, {
        headers: { 'X-Flow-Token': token },
      })
      const data = await res.json()
      const n = Array.isArray(data.projects) ? data.projects.length : 0
      process.stdout.write(`MCP-OK ${n} projects\r\n> `)
    } catch (e) {
      process.stdout.write(`MCP-ERR ${e.message}\r\n> `)
    }
    return
  }

  if (cmd.includes('commit-check')) {
    awaitingApproval = true
    process.stdout.write('PERMISSION-PROMPT git_commit [y/n]\r\n')
    return
  }

  process.stdout.write(`echo: ${cmd}\r\n> `)
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let idx
  // Treat CR or LF as line terminators — xterm sends \r on Enter.
  while ((idx = buf.search(/[\r\n]/)) !== -1) {
    const line = buf.slice(0, idx)
    buf = buf.slice(idx + 1)
    void handleLine(line)
  }
})

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
