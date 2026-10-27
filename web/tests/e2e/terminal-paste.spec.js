import { expect, test } from '@playwright/test'

// Pasting text into the web terminal should reach the PTY over the WebSocket.
// We dispatch a synthetic paste event (no real OS clipboard needed); the fake
// engine echoes whole lines, so the pasted text shows up in the session output.
const TOKEN = 'flow-e2e-token'
const HEADERS = { 'X-Flow-Token': TOKEN }

test('pasting text into the terminal reaches the session', async ({ page, request }) => {
  await page.goto(`/?token=${TOKEN}`)
  await request.post('/api/orchestrator', { headers: HEADERS, data: { action: 'stop' } })

  await page.getByRole('button', { name: 'Orchestrator' }).click()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.locator('.orchestrator__id .orchestrator__status')).toHaveText(/running/i)
  const id = (await (await request.get('/api/orchestrator', { headers: HEADERS })).json()).id

  await expect(page.locator('.terminal-panel .xterm')).toBeVisible()
  await page.waitForTimeout(800) // WS connect + fake engine boot

  // Synthetic paste (trailing newline so the line-based fake echoes it).
  await page.evaluate(() => {
    const el = document.querySelector('.terminal-panel')
    const dt = new DataTransfer()
    dt.setData('text/plain', 'PASTE-PROBE-7777\n')
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    )
  })

  await expect
    .poll(
      async () => {
        const r = await request.get(`/api/sessions/${id}/replay`, { headers: HEADERS })
        return r.ok() ? (await r.json()).output : ''
      },
      { timeout: 10_000, intervals: [200, 400, 800] },
    )
    .toContain('PASTE-PROBE-7777')

  await request.post('/api/orchestrator', { headers: HEADERS, data: { action: 'stop' } })
})
