import { expect } from '@playwright/test'
import { test } from './_fixtures.ts'

/**
 * Adversarial auth suite — passwordless canon 2026-05-13 per
 * `[[auth-passwordless-canon]]`. Each case documents a specific invariant
 * that real users would notice if broken. Exact-value URL asserts и
 * explicit error-text matches (not just «some error»).
 *
 * Runs under the `chromium` project with `storageState: owner-w{idx}.json`
 * unless `test.use({ storageState: ... })` overrides within a `describe`.
 *
 * Legacy email+password tests dropped wholesale: SignInForm/SignUpForm
 * components removed, BA `emailAndPassword` disabled, captcha-gate scoped
 * к `/sign-in/magic-link` only. Magic-link flow coverage lives в
 * `onboarding-90s.spec.ts` (full happy path) и here (anonymous edge cases).
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

	test('inverse guard: /welcome redirects (owner has org) к /', async ({ page }) => {
		// /welcome.beforeLoad: activeOrganizationId set → throw redirect к /.
		// Prevents accidental org-double-create when an old magic-link is
		// clicked or the URL is bookmarked.
		await page.goto('/welcome')
		await expect(page).not.toHaveURL(/\/welcome/)
	})

	test('cross-tenant: visiting /o/other-slug/ redirects home (not leak)', async ({ page }) => {
		await page.goto('/o/does-not-exist-for-this-user/')
		// _app/o/$orgSlug guard bounces к '/' which lands on own org.
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
	test.use({ storageState: { cookies: [], origins: [] } })

	test('protected route → redirect to /login with ?redirect=', async ({ page }) => {
		await page.goto('/o/any-slug/')
		await expect(page).toHaveURL(/\/login\?redirect=/)
	})

	test('/login renders magic-link form (no password field on canon shift)', async ({ page }) => {
		await page.goto('/login')
		await expect(page.getByRole('heading', { name: 'Вход' })).toBeVisible()
		await expect(page.getByLabel('Email')).toBeVisible()
		// «Пароль» field MUST NOT exist post passwordless-canon.
		await expect(page.getByLabel('Пароль')).toHaveCount(0)
		await expect(page.getByRole('button', { name: 'Получить ссылку для входа' })).toBeVisible()
	})

	test('/signup renders MagicLinkSignUpForm (no password field)', async ({ page }) => {
		await page.goto('/signup')
		await expect(page.getByRole('heading', { name: 'Регистрация' })).toBeVisible()
		await expect(page.getByLabel('Email')).toBeVisible()
		await expect(page.getByLabel('Название гостиницы')).toBeVisible()
		await expect(page.getByLabel('Пароль')).toHaveCount(0)
		// Submit button copy is signup-specific (different from /login).
		await expect(
			page.getByRole('button', { name: 'Получить ссылку для регистрации' }),
		).toBeVisible()
	})

	test('/signup без consent → submit disabled (152-ФЗ hard gate)', async ({ page }) => {
		await page.goto('/signup')
		await page.getByLabel('Email').fill('no-consent@sochi.local')
		await page.getByLabel('Название гостиницы').fill('No Consent Hotel')
		// Deliberately NOT checking consent.
		await expect(
			page.getByRole('button', { name: 'Получить ссылку для регистрации' }),
		).toBeDisabled()
	})

	test('/welcome без сессии → redirect к /login', async ({ page }) => {
		await page.goto('/welcome')
		// beforeLoad: !session.session → throw redirect к /login.
		await expect(page).toHaveURL(/\/login(\?|$)/)
	})

	test('/privacy is publicly accessible', async ({ page }) => {
		await page.goto('/privacy')
		await expect(page.getByRole('heading', { name: /Политика конфиденциальности/ })).toBeVisible()
	})
})
