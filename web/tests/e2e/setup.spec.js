import { expect, test } from '@playwright/test'

// The Setup page against the fixture workspace: the Workspace card reads as
// ready, and switching an optional section off removes its tab from the strip
// (and the switch is put back so later specs see the default tabs).
const TOKEN = 'flow-e2e-token'

test('setup: workspace card is ready, and a section can be hidden', async ({ page }) => {
  await page.goto(`/?token=${TOKEN}`)
  await page.getByRole('button', { name: 'Setup', exact: true }).click()

  await expect(page.locator('#setup-workspace .check.ready')).toBeVisible()

  const diffSwitch = page.locator('.settings-toggle', { hasText: 'Diff' }).locator('input')
  const diffTab = page.getByRole('button', { name: 'Diff', exact: true })

  await diffSwitch.uncheck()
  await expect(diffTab).toHaveCount(0)

  await diffSwitch.check()
  await expect(diffTab).toBeVisible()
})
