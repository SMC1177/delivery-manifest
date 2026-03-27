import { test, expect } from '@playwright/test'

test.describe('Smoke tests', () => {
  test('landing page loads', async ({ page }) => {
    await page.goto('/')
    // The page should load and have a title or visible content
    await expect(page).toHaveTitle(/.+/)
  })

  test('login page renders with email and password fields', async ({ page }) => {
    await page.goto('/login')
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]')
    const passwordInput = page.locator('input[type="password"], input[name="password"], input[placeholder*="password" i]')
    await expect(emailInput.first()).toBeVisible({ timeout: 10000 })
    await expect(passwordInput.first()).toBeVisible({ timeout: 10000 })
  })

  test('404 handling for nonexistent route', async ({ page }) => {
    await page.goto('/nonexistent-route-that-does-not-exist')
    // Should either redirect to login/home or show some content (not a blank page)
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
  })
})
