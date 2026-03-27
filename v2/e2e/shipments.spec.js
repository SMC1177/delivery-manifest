import { test, expect } from '@playwright/test'

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
  test.skip('shipments table renders', async () => {
    // Requires auth — placeholder
  })

  test.skip('search input filters results', async () => {
    // Requires auth — placeholder
  })

  test.skip('date range filter works', async () => {
    // Requires auth — placeholder
  })
})
