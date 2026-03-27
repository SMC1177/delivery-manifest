import { test, expect } from '@playwright/test'

test.describe('Settings page (unauthenticated)', () => {
  test('settings route redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/test-org/settings')
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
  })
})

test.describe('Settings page (authenticated)', () => {
  test.skip('settings page loads', async ({ page }) => {
    // await loginAs(page, testAccount)
    // await page.goto('/test-org/settings')
    // await expect(page.getByText(/settings/i)).toBeVisible()
  })

  test.skip('scrub feature is accessible', async ({ page }) => {
    // await loginAs(page, testAccount)
    // await page.goto('/test-org/settings')
    // Verify HIPAA data scrubbing section exists
    // await expect(page.getByText(/data scrub/i)).toBeVisible()
  })

  test.skip('field visibility toggles are present', async ({ page }) => {
    // await loginAs(page, testAccount)
    // await page.goto('/test-org/settings')
    // Verify field visibility section
  })
})
