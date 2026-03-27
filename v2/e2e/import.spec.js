import { test, expect } from '@playwright/test'

test.describe('Import page', () => {
  test('import page loads at root (redirects to login)', async ({ page }) => {
    await page.goto('/test-org/import')
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
  })

  test('landing page has no Phase 2 stub text', async ({ page }) => {
    await page.goto('/')
    const stubText = page.getByText('File parsing coming in Phase 2')
    await expect(stubText).not.toBeVisible({ timeout: 5000 })
  })
})

test.describe('Import page (authenticated)', () => {
  // TODO: Add login helper when test account is configured

  test.skip('file input accepts .xlsx and .xls', async () => {
    // Requires auth — placeholder
  })

  test.skip('after selecting file, preview UI appears (not stub)', async () => {
    // Requires auth — placeholder
  })

  test.skip('cancel button dismisses the modal', async () => {
    // Requires auth — placeholder
  })
})
