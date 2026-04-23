import { expect, test } from '@playwright/test'

/**
 * Adversarial auth suite — hunts regressions, each case documents a
 * specific invariant that real users would notice if broken. Exact-value
 * URL asserts and explicit error-text matches (not just "some error").
 *
 * Runs under the `chromium` project with `storageState: owner.json`
 * unless `test.use({ storageState: ... })` overrides within a `describe`.
 */

test.describe('authenticated owner', () => {
	test('redirect to own /o/{slug}/ when visiting /', async ({ page }) => {
		await page.goto('/')
		await expect(page).toHaveURL(/\/o\/e2e-hotel-\d+\/?$/)
	})

	test('inverse guard: /login redirects to /', async ({ page }) => {
		await page.goto('/login')
		await expect(page).not.toHaveURL(/\/login/)
	})

	test('inverse guard: /signup redirects to /', async ({ page }) => {
		await page.goto('/signup')
		await expect(page).not.toHaveURL(/\/signup/)
	})

	test('cross-tenant: visiting /o/other-slug/ redirects home (not leak)', async ({ page }) => {
		await page.goto('/o/does-not-exist-for-this-user/')
		// _app/o/$orgSlug guard bounces to '/' which in turn lands on own org.
		await expect(page).toHaveURL(/\/o\/e2e-hotel-\d+\/?$/)
	})

	test('logout: clears session + lands on /login', async ({ page }) => {
		await page.goto('/')
		await expect(page).toHaveURL(/\/o\/e2e-hotel-\d+\/?$/)
		await page.getByRole('button', { name: 'Выйти' }).click()
		await expect(page).toHaveURL(/\/login$/)
	})
})

test.describe('anonymous', () => {
	// Fresh browser context — no session cookie.
	test.use({ storageState: { cookies: [], origins: [] } })

	test('protected route → redirect to /login with ?redirect=', async ({ page }) => {
		await page.goto('/o/any-slug/')
		await expect(page).toHaveURL(/\/login\?redirect=/)
	})

	test('/login renders with form + correct labels', async ({ page }) => {
		await page.goto('/login')
		await expect(page.getByRole('heading', { name: /Вход/ })).toBeVisible()
		await expect(page.getByLabel('Email')).toBeVisible()
		await expect(page.getByLabel('Пароль')).toBeVisible()
		await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible()
	})

	test('wrong password → stays on /login + inline error', async ({ page }) => {
		await page.goto('/login')
		await page.getByLabel('Email').fill('nobody@sochi.local')
		await page.getByLabel('Пароль').fill('wrong-password-xyz')
		await page.getByRole('button', { name: 'Войти' }).click()
		await expect(page.getByRole('alert')).toContainText(/Неверный|слишком много/i)
		await expect(page).toHaveURL(/\/login/)
	})

	test('signup without 152-ФЗ consent → form blocks submission', async ({ page }) => {
		await page.goto('/signup')
		await page.getByLabel('Ваше имя').fill('No Consent')
		await page.getByLabel('Email').fill(`no-consent-${Date.now()}@sochi.local`)
		await page.getByLabel('Пароль').fill('playwright-e2e-01')
		await page.getByLabel('Название гостиницы').fill('No Consent Hotel')
		// HTML5 `required` on checkbox blocks submission — URL stays on /signup.
		await page.getByRole('button', { name: 'Создать аккаунт' }).click()
		await expect(page).toHaveURL(/\/signup/)
	})

	test('/privacy is publicly accessible', async ({ page }) => {
		await page.goto('/privacy')
		await expect(
			page.getByRole('heading', { name: /Политика конфиденциальности/ }),
		).toBeVisible()
	})
})
