import { expect, test as setup } from '@playwright/test'
import { getMagicLinkUrl, purgeMailpit } from './_mailpit-helper.ts'

/**
 * Setup project: create a fresh owner user + org via the **passwordless
 * canon** flow (magic-link signup + /welcome org-create + 2-step onboarding
 * wizard), so downstream `chromium` tests land on a real tenant dashboard.
 *
 * **Passwordless canon 2026-05-13** per `[[auth-passwordless-canon]]`: BA
 * `emailAndPassword` removed wholesale. Sole signup flow:
 *   1. /signup → MagicLinkSignUpForm: email + consent + (captcha). Round
 *      14.6.2 (2026-05-28): NO orgName field — hotel name comes later via
 *      ИНН/DaData lookup (one source of truth, zero retyping).
 *   2. Backend sends magic-link via MailpitAdapter (dev SMTP 1125)
 *   3. Test fetches the link out of Mailpit HTTP API (port 8125), visits it
 *   4. BA verify creates user JIT + sets cookie → 302 to /welcome
 *   5. /welcome beforeLoad AUTO-creates org (placeholder name + `org-<base36>`
 *      slug) и redirects — NO UI interaction → /o/$slug/setup
 *   6. 2-screen onboarding wizard runs (identify ИНН → inventory)
 *   7. Land on /o/$slug/grid → save per-worker storageState
 *
 * **DaData mock seam** per `[[mock-seam-at-adapter-not-http]]`: the wizard's
 * `find-by-inn` POST hits backend `dadata.mock` directly (Playwright
 * `webServer.env.DADATA_API_KEY=''` forces mock binding). ИНН 2320000001 →
 * canonical ООО «Демо-Сириус».
 *
 * **Per-worker tenant** (Phase 16 closure 2026-05-13): each Playwright
 * worker creates its OWN tenant + storage state. Together with
 * `fullyParallel: true` + `workers: 4` + per-worker `storageState` fixture
 * in `_fixtures.ts`, gives ~3–4× CI wall-clock speed-up without cross-
 * worker booking/state contention.
 */
setup(
	'authenticate owner via magic-link + complete 2-step wizard',
	async ({ page, request }, setupInfo) => {
		const ts = Date.now()
		const workerIdx = setupInfo.workerIndex
		const email = `e2e-owner-${ts}-w${workerIdx}@sochi.local`

		// Purge Mailpit at setup start so `getMagicLinkUrl(email)` matches the
		// freshly-sent message, not stale seed emails из prior runs.
		await purgeMailpit(request)

		// --- /signup → MagicLinkSignUpForm ---
		await page.goto('/signup')
		await expect(page.getByRole('heading', { name: 'Регистрация' })).toBeVisible()

		await page.getByLabel('Email').fill(email)
		await page.getByLabel(/согласие/).check()

		await page.getByRole('button', { name: 'Получить ссылку для регистрации' }).click()
		// Round 14.6.2: signup captures ONLY email + consent (no orgName). The
		// confirmation surfaces «Письмо отправлено» + the email (НЕ orgName).
		await expect(page.getByText('Письмо отправлено')).toBeVisible()
		await expect(page.getByText(email)).toBeVisible()

		// --- Fetch magic-link URL out of Mailpit + visit it ---
		const magicLinkUrl = await getMagicLinkUrl(request, email)
		await page.goto(magicLinkUrl)

		// --- /welcome: beforeLoad AUTO-creates org (placeholder name + `org-<base36>`
		// slug) and redirects — NO UI interaction (Round 14.6.2). The empty-tenant
		// dashboard guard at `/o/$slug/` then redirects to /setup. Slug is `org-…`,
		// NOT derived from any typed name, so the URL match is generic. ---
		await page.waitForURL(/\/o\/[^/?]+\/setup$/)
		const match = page.url().match(/\/o\/([^/?]+)\/setup$/)
		const orgSlug = match?.[1] ?? ''
		expect(orgSlug).not.toBe('')

		// --- Wizard Screen 1: identify (ИНН lookup against dadata.mock) ---
		await expect(page.getByRole('heading', { name: 'Заводим гостиницу' })).toBeVisible()
		await expect(page.locator('li[aria-current="step"]')).toContainText('Гостиница')

		const innInput = page.getByLabel('ИНН гостиницы')
		await expect(innInput).toBeVisible()
		await expect(page.getByRole('button', { name: 'Найти' })).toBeDisabled()
		await innInput.fill('232') // partial — still invalid
		await expect(page.getByRole('button', { name: 'Найти' })).toBeDisabled()
		await innInput.fill('2320000001') // canonical demo ИНН (mock-dadata.ts)
		await expect(page.getByRole('button', { name: 'Найти' })).toBeEnabled()
		await page.getByRole('button', { name: 'Найти' }).click()

		const preview = page.getByRole('complementary', { name: 'Найденная организация' })
		await expect(preview).toBeVisible()
		await expect(preview).toContainText('ООО «Демо-Сириус»')
		await expect(preview).toContainText('2320000001')

		await page.getByRole('button', { name: /Подтвердить/ }).click()

		// --- Wizard Screen 2: inventory (defaults 10 × 3500) ---
		await expect(page.locator('li[aria-current="step"]')).toContainText('Номера и цена')
		await expect(page.getByLabel('Сколько номеров?')).toHaveValue('10')
		await expect(page.getByLabel('Цена за ночь, ₽')).toHaveValue('3500')

		// Round 14.6 wow-flow: finishing the wizard lands on the per-tenant /demo
		// OTA showcase (NOT /grid directly). The session is fully provisioned here.
		await Promise.all([
			page.waitForURL(/\/o\/[^/]+\/demo$/),
			page.getByRole('button', { name: /Готово/ }).click(),
		])

		// Privacy-preserving cookie choice (decline analytics). Dismissing here
		// persists the localStorage flag into storageState → downstream tests get
		// a clean viewport без баннера, перехватывающего клики по футеру форм.
		const declineCookies = page.getByRole('button', { name: 'Только необходимые' })
		if (await declineCookies.isVisible().catch(() => false)) {
			await declineCookies.click()
		}

		// --- Grid landing — empirical end-to-end gate ---
		// An onboarded tenant MUST see its own «Стандартный» room type on the grid
		// (10 rooms seeded at wizard step). If it doesn't appear, that is a REAL
		// product bug (new hotelier can't see their inventory), NOT a test concern
		// to weaken away. Appears asynchronously после CDC drains inventory-create.
		await page.goto(`/o/${orgSlug}/grid`)
		const rowheader = page.getByRole('rowheader', { name: 'Стандартный' })
		await expect(rowheader).toBeVisible({ timeout: 30_000 })
		await expect(page.getByRole('grid')).toHaveAttribute('aria-colcount', '16')

		await page.context().storageState({ path: `tests/.auth/owner-w${workerIdx}.json` })
	},
)
