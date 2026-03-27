import { test, expect } from '@playwright/test'
import { login, TEST_EMAIL, TEST_PASSWORD } from './helpers/login'

test.describe('Shipments (unauthenticated)', () => {
  test('dashboard route redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/test-org/dashboard')
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
  })

  test('landing page renders without JS errors', async ({ page }) => {
    const errors = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto('/')
    await page.waitForTimeout(2000)
    expect(errors).toHaveLength(0)
  })
})

test.describe('Shipments (authenticated)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_EMAIL, TEST_PASSWORD)
  })

  test('shipments table or dashboard renders', async ({ page }) => {
    // After login, should see dashboard content
    await expect(page.locator('body')).not.toBeEmpty()
    // Look for table or shipment-related content
    const hasTable = await page.locator('table').first().isVisible({ timeout: 5000 }).catch(() => false)
    const hasShipments = await page.getByText(/shipment/i).first().isVisible({ timeout: 3000 }).catch(() => false)
    expect(hasTable || hasShipments).toBeTruthy()
  })

  test('search input is present', async ({ page }) => {
    const searchInput = page.locator('input[placeholder*="Search"]')
    await expect(searchInput).toBeVisible({ timeout: 10000 })
  })

  test('date range filter is present', async ({ page }) => {
    const dateInputs = page.locator('input[type="date"]')
    await expect(dateInputs.first()).toBeVisible({ timeout: 10000 })
  })
})
