import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { getMagicLinkUrl, purgeMailpit } from './_mailpit-helper.ts'

/**
 * 90-second onboarding budget — empirical wall-clock measurement of the
 * canonical solo-owner flow per `[[demo_strategy]]` + the canon committed
 * in `0c31ecf` (frontend) + `1d9f344` (backend bulk endpoint) +
 * `[[auth-passwordless-canon]]` (magic-link only).
 *
 * Story under measurement:
 *   1. anonymous /signup → MagicLinkSignUpForm (email + orgName + consent)
 *   2. submit → BA dispatches magic-link via MailpitAdapter
 *   3. test fetches link from Mailpit HTTP API and visits it
 *   4. BA verify creates user JIT + sets cookie → 302 to /welcome?n=<orgName>
 *   5. /welcome: confirm orgName → organization.create → navigate to /setup
 *   6. /setup Screen 1 — type ИНН, Найти → DaData preview, Подтвердить →
 *   7. /setup Screen 2 — defaults (10 rooms × 3500₽), Готово →
 *   8. single-tx bulk POST commits property + roomType + N rooms + ratePlan
 *   9. landing on /o/$slug/grid — empty Шахматка с roomheader visible
 *
 * Budget: < 90_000 ms total measured from signup submit (which dispatches
 * the magic-link email). Soft threshold — failure here is a real regression
 * (SMTP delivery delay, bulk-tx slowdown, beforeLoad N+1), не flake. Backend
 * N≤200 inside one tx (per-row UPSERT inside `sql.begin` per
 * `[[ydb_as_table_optional_typing]]`) is well-tested below this budget.
 *
 * Anonymous project: no storageState dependency. Lives in the `smoke`
 * Playwright project (testMatch tuned in playwright.config.ts) so it does
 * NOT depend on `auth.setup.ts`.
 *
 * **Behaviour-faithful mock seam** per `[[mock-seam-at-adapter-not-http]]`:
 * the test hits production `dadata.mock` adapter directly (Playwright
 * `webServer.env.DADATA_API_KEY=''` forces mock binding). ИНН `2320000001`
 * is the canonical Сочи demo record и passes through the same code path
 * the public hosted demo tenant will use forever per `[[demo_strategy]]`.
 *
 * Layer 5 (a11y): axe-core WCAG 2.2 AA scan at three checkpoints —
 * /signup form, /welcome, /setup Screen 1 — gate per
 * `[[layer_4_5_mandatory_per_subphase]]`. Grid axe scan lives separately
 * in `grid-a11y.spec.ts` (deeper coverage); duplicating here only adds
 * runtime без new signal.
 */

const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const

async function expectAxeClean(page: import('@playwright/test').Page, scope: string): Promise<void> {
	const results = await new AxeBuilder({ page }).withTags([...A11Y_TAGS]).analyze()
	if (results.violations.length > 0) {
		console.error(`axe violations at ${scope}:`, JSON.stringify(results.violations, null, 2))
	}
	expect(results.violations).toEqual([])
}

test('signup → magic-link → /welcome → ИНН → inventory → Шахматка lands under 90 seconds', async ({
	page,
	request,
}) => {
	const ts = Date.now()
	const email = `e2e-budget-${ts}@sochi.local`
	const orgName = `Budget Hotel ${ts}`

	await purgeMailpit(request)

	// --- t0: about-to-submit signup ---
	await page.goto('/signup')
	await expect(page.getByRole('heading', { name: 'Регистрация' })).toBeVisible()

	await page.getByLabel('Email').fill(email)
	await page.getByLabel('Название гостиницы').fill(orgName)
	await page.getByLabel(/согласие/).check()

	// a11y checkpoint #1 — signup form filled.
	await expectAxeClean(page, '/signup form filled')

	const t0 = Date.now()
	await page.getByRole('button', { name: 'Получить ссылку для регистрации' }).click()
	await expect(page.getByText('Письмо отправлено')).toBeVisible()

	// --- Fetch magic-link from Mailpit + visit it ---
	const magicLinkUrl = await getMagicLinkUrl(request, email)
	await page.goto(magicLinkUrl)

	// --- /welcome ---
	await expect(page.getByRole('heading', { name: 'Почти готово' })).toBeVisible()
	const orgNameInput = page.getByLabel('Название гостиницы')
	await expect(orgNameInput).toHaveValue(orgName)

	// a11y checkpoint #2 — /welcome with orgName prefilled.
	await expectAxeClean(page, '/welcome prefilled')

	await Promise.all([
		page.waitForURL(/\/o\/[^/]+\/setup$/),
		page.getByRole('button', { name: 'Создать гостиницу →' }).click(),
	])

	// --- /setup Screen 1: identify ---
	await expect(page.getByLabel('ИНН гостиницы')).toBeVisible()

	// a11y checkpoint #3 — /setup Screen 1 idle.
	await expectAxeClean(page, '/setup screen 1 idle')

	// Canonical demo ИНН from `apps/backend/src/domains/identity/dadata/
	// mock-dadata.ts` → ООО «Демо-Сириус» (Сочи / USN / ACTIVE).
	await page.getByLabel('ИНН гостиницы').fill('2320000001')
	await page.getByRole('button', { name: 'Найти' }).click()
	await expect(page.getByRole('complementary', { name: 'Найденная организация' })).toBeVisible()
	await page.getByRole('button', { name: /Подтвердить/ }).click()

	// --- /setup Screen 2: inventory ---
	await expect(page.locator('li[aria-current="step"]')).toContainText('Номера и цена')
	await expect(page.getByLabel('Сколько номеров?')).toHaveValue('10')
	await expect(page.getByLabel('Цена за ночь, ₽')).toHaveValue('3500')

	await Promise.all([
		page.waitForURL(/\/o\/[^/]+\/grid$/),
		page.getByRole('button', { name: /Готово/ }).click(),
	])

	// --- Grid landing: empirical end-to-end gate ---
	await expect(page.getByRole('rowheader', { name: 'Стандартный' })).toBeVisible()
	await expect(page.getByRole('grid')).toHaveAttribute('aria-colcount', '16')

	const elapsedMs = Date.now() - t0
	console.log(`[onboarding-90s] wall-clock signup→grid: ${elapsedMs} ms`)
	expect(elapsedMs).toBeLessThan(90_000)
})
