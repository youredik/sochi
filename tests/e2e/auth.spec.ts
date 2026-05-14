import { expect } from '@playwright/test'
import { test } from './_fixtures.ts'
import { getMagicLinkUrl, purgeMailpit } from './_mailpit-helper.ts'

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
		await expect(page).toHaveURL(/\/o\/e2e-hotel-\d+-w\d+\/?$/)
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
		await expect(page).toHaveURL(/\/o\/e2e-hotel-\d+-w\d+\/?$/)
	})

	// Logout test moved to «anonymous» describe — it used к live в this block
	// but BA session-invalidate is server-side: clicking «Выйти» здесь mutated
	// the shared per-worker tenant's session record, leaving subsequent specs
	// (wizard, grid) с a dead cookie. The replacement (below) mints an
	// ephemeral JIT user, then logs out — fully isolated from owner-w*.json.
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

	test('JIT signin (никогда не виденный email через /login) лендится на /welcome без redirect-loop', async ({
		page,
		request,
	}) => {
		// Regression guard for the silent-loop bug uncovered 2026-05-14:
		// `_app.tsx` beforeLoad sent orgless sessions к `/signup`, whose own
		// inverse guard then bounced authenticated users back к `/` — а это
		// снова `_app.tsx`. Result: infinite `GET /api/auth/organization/list`
		// flood в DevTools, blank screen, URL bar stuck on `/`. After the fix,
		// the orgless branch redirects к `/welcome` (org-creation form), which
		// has no inverse guard for the «session + no-org» state and renders.
		//
		// Path under test: /login → magic-link (BA `disableSignUp: false` →
		// JIT user create, no org) → /welcome. Distinct от `/signup` happy
		// path covered in `onboarding-90s.spec.ts` which carries orgName в the
		// callbackURL query.
		const ts = Date.now()
		const email = `e2e-jit-signin-${ts}@sochi.local`

		await purgeMailpit(request)

		await page.goto('/login')
		await expect(page.getByRole('heading', { name: 'Вход' })).toBeVisible()
		await page.getByLabel('Email').fill(email)
		await page.getByRole('button', { name: 'Получить ссылку для входа' }).click()
		await expect(page.getByText('Письмо отправлено')).toBeVisible()

		const magicLinkUrl = await getMagicLinkUrl(request, email)
		await page.goto(magicLinkUrl)

		// Strict: lands on /welcome, NOT on /signup, NOT bouncing on /.
		await expect(page).toHaveURL(/\/welcome(\?|$)/)
		await expect(page).not.toHaveURL(/\/signup/)
		await expect(page.getByRole('heading', { name: 'Почти готово' })).toBeVisible()
		// orgName field is empty — sign-in flow carries no `?n=…` param.
		await expect(page.getByLabel('Название гостиницы')).toHaveValue('')

		// Network-quiet check: no infinite `organization/list` hammering. If the
		// loop ever returns, this fails because the page never stops fetching.
		await page.waitForLoadState('networkidle', { timeout: 5_000 })
	})

	test('logout: ephemeral JIT user → «Выйти» clears session + lands on /login', async ({
		page,
		request,
	}) => {
		// Isolated logout — mints its own throwaway user via /login magic-link
		// + creates org in /welcome, so the click on «Выйти» mutates *only this
		// test's* tenant in YDB. Earlier this lived в the «authenticated owner»
		// block sharing owner-w0.json и killed sibling specs reading the same
		// storageState (dead cookie).
		const ts = Date.now()
		const email = `e2e-logout-${ts}@sochi.local`
		const orgName = `Logout Hotel ${ts}`

		await purgeMailpit(request)

		await page.goto('/signup')
		await page.getByLabel('Email').fill(email)
		await page.getByLabel('Название гостиницы').fill(orgName)
		await page.getByLabel(/согласие/).check()
		await page.getByRole('button', { name: 'Получить ссылку для регистрации' }).click()
		await expect(page.getByText('Письмо отправлено')).toBeVisible()

		const magicLinkUrl = await getMagicLinkUrl(request, email)
		await page.goto(magicLinkUrl)

		await expect(page.getByRole('heading', { name: 'Почти готово' })).toBeVisible()
		await Promise.all([
			page.waitForURL(/\/o\/[^/]+\/setup$/),
			page.getByRole('button', { name: 'Создать гостиницу →' }).click(),
		])

		// Now на /setup wizard — sidebar's «Выйти» button is reachable.
		await page.getByRole('button', { name: 'Выйти' }).click()
		await expect(page).toHaveURL(/\/login$/)
	})

	test('/privacy is publicly accessible', async ({ page }) => {
		await page.goto('/privacy')
		await expect(page.getByRole('heading', { name: /Политика конфиденциальности/ })).toBeVisible()
	})
})
