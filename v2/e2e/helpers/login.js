/**
 * Log in with email/password via the login page UI.
 * Waits for redirect to dashboard after successful login.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} email
 * @param {string} password
 * @returns {Promise<string>} org slug extracted from dashboard URL
 */
export async function login(page, email, password) {
  await page.goto('/login')
  await page.locator('input[type="email"]').fill(email)
  await page.locator('input[type="password"]').fill(password)
  await page.locator('button[type="submit"]').click()

  // Wait for any post-login redirect away from /login
  await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 20000 })

  // If we landed on welcome page, dismiss it
  const currentUrl = page.url()
  if (currentUrl.includes('/welcome')) {
    const skipBtn = page.getByText(/skip/i).first()
    const startBtn = page.getByText(/get started|start|continue/i).first()
    if (await skipBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await skipBtn.click()
    } else if (await startBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await startBtn.click()
    }
    await page.waitForURL(/\/dashboard/, { timeout: 10000 })
  }

  // Extract slug from current URL
  const slug = getSlug(page)
  if (!slug) {
    // If not on a slug page yet, wait for dashboard redirect
    await page.waitForURL(/\/[^/]+\/dashboard/, { timeout: 10000 })
  }

  return getSlug(page)
}

/**
 * Get the org slug from the current URL (assumes /:slug/something)
 */
export function getSlug(page) {
  const url = new URL(page.url())
  const match = url.pathname.match(/^\/([^/]+)\//)
  return match?.[1] || ''
}

export const TEST_EMAIL = 'testflight@smacktax.com'
export const TEST_PASSWORD = 'TestFlight2026!'

export const ADMIN_EMAIL = 'support@smacktax.com'
export const ADMIN_PASSWORD = 'Yahtzee641517'
