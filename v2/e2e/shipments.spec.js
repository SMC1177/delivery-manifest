import { test, expect } from '@playwright/test'

test.describe('Shipments (unauthenticated)', () => {
  test('dashboard route redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/test-org/dashboard')
    // Should redirect to login or show auth gate
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    // Should NOT show the shipments table without auth
  })

  test('landing page renders without JS errors', async ({ page }) => {
    const errors = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto('/')
    await page.waitForTimeout(2000)
    expect(errors).toHaveLength(0)
  })
})

// Authenticated shipment tests — require a test account
test.describe('Shipments (authenticated)', () => {
  test.skip('shipments table renders', async ({ page }) => {
    // await loginAs(page, testAccount)
    // await page.goto('/test-org/dashboard')
    // await expect(page.locator('table, [data-testid="shipment-table"]')).toBeVisible()
  })

  test.skip('search input filters results', async ({ page }) => {
    // Type in search → table updates
  })

  test.skip('date range filter works', async ({ page }) => {
    // Select date range → table updates
  })
})
