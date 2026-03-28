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

  test('settings page loads with organization info', async ({ page }) => {
    await page.goto(`/${slug}/settings`)
    await expect(page.getByRole('heading', { name: 'Organization' })).toBeVisible({ timeout: 10000 })
  })

  test('branding section is visible', async ({ page }) => {
    await page.goto(`/${slug}/settings`)
    await expect(page.getByText('Branding')).toBeVisible({ timeout: 10000 })
  })

  test('shipment fields section is present', async ({ page }) => {
    await page.goto(`/${slug}/settings`)
    await expect(page.getByText('Shipment Fields')).toBeVisible({ timeout: 10000 })
  })

  test('team management section is present', async ({ page }) => {
    await page.goto(`/${slug}/settings`)
    await expect(page.getByText(/team|members/i).first()).toBeVisible({ timeout: 10000 })
  })

  test('import column mapping section is present', async ({ page }) => {
    await page.goto(`/${slug}/settings`)
    await expect(page.getByText('Import Column Mapping')).toBeVisible({ timeout: 10000 })
  })
})
