import { expect, test } from '@playwright/test'

// Full-flow test against the daemon-served SPA with a fake `claude` engine.
// Proves: start → live PTY streaming → browser keyboard input over WS →
// orchestrator's env-injected callback to the daemon API → permission-prompt
// round trip → reattach across reload → stop.
const TOKEN = 'flow-e2e-token'
const HEADERS = { 'X-Flow-Token': TOKEN }

/** The xterm canvas isn't in the DOM, so assert terminal content via replay. */
async function expectReplayContains(request, id, needle) {
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/sessions/${id}/replay`, { headers: HEADERS })
        if (!res.ok()) return ''
        return (await res.json()).output ?? ''
      },
      { timeout: 15_000, intervals: [250, 500, 1000] },
    )
    .toContain(needle)
}

async function typeLine(page, text) {
  await page.locator('.xterm-helper-textarea').click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

test('orchestrator: start, MCP callback, permission round trip, reattach, stop', async ({
  page,
  request,
}) => {
  // Auth via the one-time token in the URL, then land on the Orchestrator tab.
  await page.goto(`/?token=${TOKEN}`)
  await page.getByRole('button', { name: 'Orchestrator' }).click()

  // Make sure we start from a clean slate (a prior run may have left it up).
  await request.post('/api/orchestrator', { headers: HEADERS, data: { action: 'stop' } })

  // Start → status pill flips to running (real DOM signal).
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.locator('.orchestrator__id .orchestrator__status')).toHaveText(/running/i)

  // Resolve the spawned session id from the daemon.
  const status = await (await request.get('/api/orchestrator', { headers: HEADERS })).json()
  expect(status.running).toBe(true)
  const id = status.id

  // The fake engine booted and is streaming into the PTY.
  await expectReplayContains(request, id, 'FAKE-CLAUDE READY')

  // Browser keyboard → WS → PTY stdin → fake calls back to the daemon API.
  await typeLine(page, 'mcp-check')
  await expectReplayContains(request, id, 'MCP-OK')

  // Permission-prompt round trip: prompt out, approval in, result out.
  await typeLine(page, 'commit-check')
  await expectReplayContains(request, id, 'PERMISSION-PROMPT git_commit')
  await typeLine(page, 'y')
  await expectReplayContains(request, id, 'APPROVED git_commit')

  // Reattach across reload: the session keeps running and the tab re-binds.
  await page.reload()
  await page.getByRole('button', { name: 'Orchestrator' }).click()
  await expect(page.locator('.orchestrator__id .orchestrator__status')).toHaveText(/running/i)
  const sameId = await (await request.get('/api/orchestrator', { headers: HEADERS })).json()
  expect(sameId.id).toBe(id)

  // Stop → pill leaves running, daemon reports stopped.
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.locator('.orchestrator__id .orchestrator__status')).not.toHaveText(/running/i)
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/orchestrator', { headers: HEADERS })).json()).running,
    )
    .toBe(false)
})
