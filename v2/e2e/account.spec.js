import { test, expect } from '@playwright/test'
import { login, TEST_EMAIL, TEST_PASSWORD, ADMIN_EMAIL, ADMIN_PASSWORD } from './helpers/login'

test.describe('Forgot Password', () => {
  test('forgot password link is visible on login page', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByText('Forgot Password?')).toBeVisible()
  })

  test('forgot password shows error without email', async ({ page }) => {
    await page.goto('/login')
    await page.getByText('Forgot Password?').click()
    // Should show error asking for email
    await expect(page.getByText(/enter your email/i)).toBeVisible({ timeout: 5000 })
  })
})

test.describe('Account Modal', () => {
  test('clicking username opens account modal (user)', async ({ page }) => {
    await login(page, TEST_EMAIL, TEST_PASSWORD)
    await page.locator('button:has-text("Joe Nobody"), button:has-text("User")').first().click()
    await expect(page.getByText('My Account')).toBeVisible({ timeout: 5000 })
  })

  test('account modal shows signed-in email', async ({ page }) => {
    await login(page, TEST_EMAIL, TEST_PASSWORD)
    await page.locator('button:has-text("Joe Nobody"), button:has-text("User")').first().click()
    await expect(page.getByText(TEST_EMAIL)).toBeVisible({ timeout: 5000 })
  })

  test('account modal shows change password form for email users', async ({ page }) => {
    await login(page, TEST_EMAIL, TEST_PASSWORD)
    await page.locator('button:has-text("Joe Nobody"), button:has-text("User")').first().click()
    await expect(page.getByRole('heading', { name: 'Change Password' })).toBeVisible({ timeout: 5000 })
  })

  test('account modal closes on X button', async ({ page }) => {
    await login(page, TEST_EMAIL, TEST_PASSWORD)
    await page.locator('button:has-text("Joe Nobody"), button:has-text("User")').first().click()
    await expect(page.getByText('My Account')).toBeVisible()
    // Click X button (svg close icon)
    await page.locator('.fixed button:has(svg)').first().click()
    await expect(page.getByText('My Account')).not.toBeVisible({ timeout: 3000 })
  })
})

test.describe('Viewer Restrictions', () => {
  test('viewer cannot see Add Shipment button', async ({ page }) => {
    await login(page, TEST_EMAIL, TEST_PASSWORD)
    await expect(page.getByText('+ Add Shipment')).not.toBeVisible({ timeout: 5000 })
  })

  test('viewer sees settings page as admin-only', async ({ page }) => {
    const slug = (await login(page, TEST_EMAIL, TEST_PASSWORD))
    await page.goto(`/${slug}/settings`)
    await expect(page.getByText(/admin access required/i)).toBeVisible({ timeout: 10000 })
  })
})

test.describe('Admin features', () => {
  test('admin can see Add Shipment button', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD)
    await expect(page.getByText('+ Add Shipment')).toBeVisible({ timeout: 10000 })
  })
})
