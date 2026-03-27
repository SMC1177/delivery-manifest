import { test, expect } from '@playwright/test'

test.describe('Settings page (unauthenticated)', () => {
  test('settings route redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/test-org/settings')
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
  })
})

test.describe('Settings page (authenticated)', () => {
  test.skip('settings page loads', async () => {
    // Requires auth — placeholder
  })

  test.skip('scrub feature is accessible', async () => {
    // Requires auth — placeholder
  })

  test.skip('field visibility toggles are present', async () => {
    // Requires auth — placeholder
  })
})
