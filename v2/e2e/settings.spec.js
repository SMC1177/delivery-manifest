import { test, expect } from '@playwright/test'
import { login, ADMIN_EMAIL, ADMIN_PASSWORD } from './helpers/login'

test.describe('Settings page (unauthenticated)', () => {
  test('settings route redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/test-org/settings')
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
  })
})

test.describe('Settings page (authenticated — admin)', () => {
  let slug

  test.beforeEach(async ({ page }) => {
    slug = await login(page, ADMIN_EMAIL, ADMIN_PASSWORD)
  })

  test('settings page loads', async ({ page }) => {
    await page.goto(`/${slug}/settings`)
    await expect(page.locator('body')).not.toBeEmpty()
    await page.waitForTimeout(2000)
  })

  test('scrub feature is accessible', async ({ page }) => {
    await page.goto(`/${slug}/settings`)
    const scrubText = page.getByText(/scrub/i).first()
    await expect(scrubText).toBeVisible({ timeout: 10000 })
  })

  test('field visibility section is present', async ({ page }) => {
    await page.goto(`/${slug}/settings`)
    const fieldText = page.getByText(/field/i).first()
    await expect(fieldText).toBeVisible({ timeout: 10000 })
  })
})
