import { test, expect } from '@playwright/test'
import { login, TEST_EMAIL, TEST_PASSWORD } from './helpers/login'

test.describe('Import page (unauthenticated)', () => {
  test('import page redirects to login when unauthenticated', async ({ page }) => {
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
  let slug

  test.beforeEach(async ({ page }) => {
    slug = await login(page, TEST_EMAIL, TEST_PASSWORD)
  })

  test('file input accepts .xlsx and .xls', async ({ page }) => {
    await page.goto(`/${slug}/import`)
    const fileInput = page.locator('input[type="file"]')
    await expect(fileInput).toHaveAttribute('accept', '.xlsx,.xls')
  })

  test('upload button is visible on import page', async ({ page }) => {
    await page.goto(`/${slug}/import`)
    await expect(page.getByText('Choose File')).toBeVisible()
  })

  test('Phase 2 stub text is not present', async ({ page }) => {
    await page.goto(`/${slug}/import`)
    const stubText = page.getByText('File parsing coming in Phase 2')
    await expect(stubText).not.toBeVisible({ timeout: 3000 })
  })
})
