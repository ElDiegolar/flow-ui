import { expect, test } from '@playwright/test'

// Smoke test: the Orchestrator tab renders and exposes its start control even
// without a live daemon (status fetch fails gracefully). For full-flow tests,
// run the daemon and open the app with a valid ?token=… first.
test('orchestrator tab renders its controls', async ({ page }) => {
  await page.goto('/')

  await expect(page.locator('.app__title > span').first()).toHaveText(/^Flow$/)

  await page.getByRole('button', { name: 'Orchestrator' }).click()

  await expect(page.getByRole('heading', { name: 'Orchestrator' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled()

  // With nothing running there are no agent panes — the view shows its empty
  // state instead. Stop lives on each pane's header, so asserting a top-level
  // Stop button here would be asserting a control that no longer exists.
  await expect(page.locator('.agent-pane')).toHaveCount(0)
  await expect(page.locator('.orchestrator__empty')).toBeVisible()
})

// Switching tabs must not reset the orchestrator: the view is kept alive, so
// the quick-view layout and the live terminal survive a round trip.
test('orchestrator layout survives a tab switch', async ({ page, request }) => {
  const TOKEN = 'flow-e2e-token'
  const HEADERS = { 'X-Flow-Token': TOKEN }
  await page.goto(`/?token=${TOKEN}`)
  await page.getByRole('button', { name: 'Orchestrator' }).click()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.locator('.agent-pane')).toHaveCount(1)

  await page.getByRole('button', { name: '2×2' }).click()
  await expect(page.locator('.orchestrator__grid')).toHaveClass(/grid-2/)
  const termBefore = await page.locator('.agent-pane .xterm').elementHandle()

  await page.getByRole('button', { name: 'Tasks' }).click()
  await page.getByRole('button', { name: 'Orchestrator' }).click()

  await expect(page.locator('.orchestrator__grid')).toHaveClass(/grid-2/)
  // Same xterm DOM node — not a fresh terminal replaying its scrollback.
  const termAfter = await page.locator('.agent-pane .xterm').elementHandle()
  expect(await page.evaluate(([a, b]) => a === b, [termBefore, termAfter])).toBe(true)

  await request.post('/api/orchestrator', { headers: HEADERS, data: { action: 'stop' } })
})
