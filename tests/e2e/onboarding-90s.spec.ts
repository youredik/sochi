import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

/**
 * 90-second onboarding budget — empirical wall-clock measurement of the
 * canonical solo-owner flow per `[[demo_strategy]]` + the canon committed
 * in `0c31ecf` (frontend) + `1d9f344` (backend bulk endpoint).
 *
 * Story under measurement:
 *   1. anonymous /signup form fill
 *   2. signup submit → backend creates user + org + redirect to /setup
 *   3. /setup Screen 1 — type ИНН, Найти → DaData preview, Подтвердить →
 *   4. /setup Screen 2 — defaults (10 rooms × 3500₽), Готово →
 *   5. single-tx bulk POST commits property + roomType + N rooms + ratePlan
 *   6. landing on /o/$slug/grid — empty Шахматка с roomheader visible
 *
 * Budget: < 90_000 ms total. Soft threshold — failure here is a real
 * regression (rate-seeding rabbit hole, N+1 in beforeLoad, etc.), not
 * flake. Backend N≤200 inside one tx (per-row UPSERT inside `sql.begin`
 * `[[ydb_as_table_optional_typing]]`) is well-tested below this budget;
 * the gate exists to catch UI-side regressions like accidental sync
 * `setState` storms during the navigate-to-/grid transition.
 *
 * Anonymous project: no storageState dependency. The spec creates a fresh
 * user inside itself — exercises the full empty-tenant→Шахматка hop. Lives
 * в the `smoke` Playwright project (testMatch tuned in playwright.config.ts)
 * so it does NOT depend on `auth.setup.ts`.
 *
 * **Behaviour-faithful mock seam** per `[[behaviour_faithful_mock_canon]]`:
 * the test hits the production `dadata.mock` adapter directly (Playwright
 * `webServer.env.DADATA_API_KEY=''` forces the factory bind to mock). ИНН
 * `2320000001` is the canonical Сочи demo record и passes through the same
 * code path the public hosted demo tenant will use forever per
 * `[[demo_strategy]]`. No HTTP-layer mocking — the seam is the adapter
 * boundary, не the network.
 *
 * Layer 5 (a11y): axe-core WCAG 2.2 AA scan at three checkpoints —
 * /signup form, /setup Screen 1, /setup Screen 2 — gate per
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

test('signup → ИНН → inventory → Шахматка lands under 90 seconds', async ({ page }) => {
	const ts = Date.now()
	const email = `e2e-budget-${ts}@sochi.local`
	const password = 'playwright-budget-01'
	const orgName = `Budget Hotel ${ts}`

	// --- t0: about-to-submit signup ---
	await page.goto('/signup')
	await expect(page.getByRole('heading', { name: 'Регистрация' })).toBeVisible()

	await page.getByLabel('Ваше имя').fill('Budget Owner')
	await page.getByLabel('Email').fill(email)
	await page.getByLabel('Пароль').fill(password)
	await page.getByLabel('Название гостиницы').fill(orgName)
	await page.getByLabel(/согласие/).check()

	// a11y checkpoint #1 — signup form, fully filled (covers focused-input
	// states, error-free baseline).
	await expectAxeClean(page, '/signup form filled')

	const t0 = Date.now()

	await Promise.all([
		page.waitForURL(/\/o\/budget-hotel-\d+\/setup$/),
		page.getByRole('button', { name: 'Создать аккаунт' }).click(),
	])

	// --- Screen 1: identify ---
	await expect(page.getByLabel('ИНН гостиницы')).toBeVisible()

	// a11y checkpoint #2 — Screen 1 idle (no preview yet).
	await expectAxeClean(page, '/setup screen 1 idle')

	// Canonical demo ИНН from `apps/backend/src/domains/identity/dadata/
	// mock-dadata.ts` → ООО «Демо-Сириус» (Сочи / USN / ACTIVE).
	await page.getByLabel('ИНН гостиницы').fill('2320000001')
	await page.getByRole('button', { name: 'Найти' }).click()
	await expect(page.getByRole('complementary', { name: 'Найденная организация' })).toBeVisible()
	await page.getByRole('button', { name: /Подтвердить/ }).click()

	// --- Screen 2: inventory ---
	await expect(page.locator('li[aria-current="step"]')).toContainText('Номера и цена')
	await expect(page.getByLabel('Сколько номеров?')).toHaveValue('10')
	await expect(page.getByLabel('Цена за ночь, ₽')).toHaveValue('3500')

	// a11y checkpoint #3 — Screen 2 с defaults visible.
	await expectAxeClean(page, '/setup screen 2 defaults')

	await Promise.all([
		page.waitForURL(/\/o\/budget-hotel-\d+\/grid$/),
		page.getByRole('button', { name: /Готово/ }).click(),
	])

	// --- Grid landing: empirical end-to-end gate ---
	await expect(page.getByRole('rowheader', { name: 'Стандартный' })).toBeVisible()
	await expect(page.getByRole('grid')).toHaveAttribute('aria-colcount', '16')

	const elapsedMs = Date.now() - t0
	console.log(`[onboarding-90s] wall-clock signup→grid: ${elapsedMs} ms`)
	expect(elapsedMs).toBeLessThan(90_000)
})
