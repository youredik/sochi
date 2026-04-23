import { expect, test as setup } from '@playwright/test'

/**
 * Setup project: create a fresh owner user + org, save the signed-in
 * storageState so downstream `chromium` tests skip the signup dance.
 *
 * Each pre-push run creates a new user (timestamp in email) — the test DB
 * never needs pruning, and cross-run pollution stays tenant-isolated.
 */
setup('authenticate owner', async ({ page }) => {
	const ts = Date.now()
	const email = `e2e-owner-${ts}@sochi.local`
	const password = 'playwright-e2e-01'
	const orgName = `E2E Hotel ${ts}`

	await page.goto('/signup')
	await expect(page.getByRole('heading', { name: /Регистрация/ })).toBeVisible()

	await page.getByLabel('Ваше имя').fill('E2E Owner')
	await page.getByLabel('Email').fill(email)
	await page.getByLabel('Пароль').fill(password)
	await page.getByLabel('Название гостиницы').fill(orgName)
	await page.getByLabel(/согласие/).check()

	await page.getByRole('button', { name: 'Создать аккаунт' }).click()

	// Landing page is /o/{slug}/ — expect the org name on the dashboard.
	await expect(page).toHaveURL(/\/o\/e2e-hotel-\d+\/?$/)
	await expect(page.getByRole('heading', { name: orgName })).toBeVisible()

	await page.context().storageState({ path: 'tests/.auth/owner.json' })
})
