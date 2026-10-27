import { defineConfig, devices } from '@playwright/test'

// Front-end e2e. We drive the *daemon* (serving the built SPA on one port) so
// the tests exercise the real HTTP/WS surface, not the Vite dev proxy. The
// orchestrator's `claude` is swapped for a deterministic fake via CLAUDE_BIN,
// and the token is pinned via FLOW_TOKEN. Runs on 8788 to avoid colliding
// with a dev daemon on 8765.
const PORT = 8788
const TOKEN = 'flow-e2e-token'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  // One worker: tests share a single daemon and the orchestrator is a singleton.
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  // Exposed to specs via testInfo.project.use / env — kept here as the source of truth.
  metadata: { token: TOKEN },
  webServer: {
    // chmod the fake claude (git may not preserve +x), create the fixture repo,
    // build the SPA, then boot the daemon with the fake engine + pinned token.
    // cwd is the repo root.
    command: [
      'chmod +x web/tests/e2e/fixtures/fake-claude.mjs',
      'sh web/tests/e2e/fixtures/workspace/seed.sh',
      'npm run build',
      `HOST=127.0.0.1 PORT=${PORT} FLOW_TOKEN=${TOKEN} ` +
        // Pin the fixture workspace + fake engine so the suite is
        // environment-independent (no real workspace needed).
        'FLOW_WORKSPACE="$PWD/web/tests/e2e/fixtures/workspace" ' +
        'CLAUDE_BIN="$PWD/web/tests/e2e/fixtures/fake-claude.mjs" ' +
        // No network at startup: the remote refresh only adds subprocesses and
        // nondeterminism to the run.
        'FLOW_SYNC_REFRESH_MS=0 ' +
        // Never reach the developer's real Atlassian/Figma from a test run: the
        // daemon would otherwise auto-connect with their cached Atlassian login.
        'FLOW_ATLASSIAN_MCP=0 FLOW_FIGMA_MCP=0 FLOW_SKIP_INTRO=1 ' +
        // Isolate the data dir: the suite otherwise writes its test token and
        // MCP config straight into the developer's real ~/.flow-ui.
        'FLOW_HOME="$PWD/web/tests/e2e/.tmp-home" ' +
        'npx tsx daemon/src/main.ts',
    ].join(' && '),
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
