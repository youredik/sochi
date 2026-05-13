import { expect, test as setup } from '@playwright/test'

/**
 * Setup project: create a fresh owner user + org + run the full 2-screen
 * onboarding wizard (identify → inventory) so downstream `chromium` tests
 * land on a real tenant dashboard, not the wizard.
 *
 * **Wizard surface (post-`0c31ecf` 2026-05-13)**: legacy 4-step flow
 * (property → roomType → rooms → ratePlan) was wholly replaced by 2 screens
 * — Screen 1 takes an ИНН and DaData auto-fills name/address/city/tax; Screen 2
 * collects rooms count + nightly price and POSTs to the single-tx
 * `/api/v1/onboarding/inventory` endpoint. The backend creates property +
 * roomType («Стандартный») + N rooms + ratePlan («Базовый») in one tx, and
 * the wizard shell evicts the dashboard's `['properties']` cache before
 * navigating to `/o/$orgSlug/grid` so the empty-tenant guard doesn't bounce
 * the operator back into the wizard.
 *
 * **Real backend, real mock adapter** per `[[behaviour_faithful_mock_canon]]`:
 * the e2e exercises the production `dadata.mock` adapter (no `DADATA_API_KEY`
 * — Playwright `webServer.env` forces it empty), so the canonical demo
 * record for ИНН `2320000001` (ООО «Демо-Сириус», city Сочи, status ACTIVE)
 * flows through the SAME code path that production demo tenants will hit.
 * No HTTP-layer mocking lives in this file — the test seam is the adapter
 * boundary, не the network.
 *
 * **Per-worker tenant (Phase 16 closure 2026-05-13)**: each Playwright
 * worker creates its OWN tenant + storage state. Together with
 * `fullyParallel: true` + `workers: 4` + per-worker `storageState` fixture
 * in `_fixtures.ts`, gives ~3–4× CI wall-clock speed-up without cross-
 * worker booking/state contention. Playwright runs the setup project once
 * per worker slot, each getting a unique `setupInfo.workerIndex`.
 *
 * Each pre-push run creates fresh user(s) (timestamp + workerIdx in email)
 * — the test DB never needs pruning и cross-run pollution stays tenant-
 * isolated.
 *
 * Adversarial checks embedded along the way:
 *   - progress indicator increments step-by-step (identify → inventory,
 *     `aria-current="step"` moves to the second `<li>` after Подтвердить →)
 *   - Найти button disabled while ИНН is malformed (deeper coverage в
 *     wizard.spec.ts)
 *   - empty-tenant dashboard at `/o/$slug/` redirects to /setup BEFORE
 *     wizard completes (validated implicitly by signup landing на /setup
 *     instead of `/`)
 *   - cache eviction works: after Готово, navigation to /grid does NOT
 *     bounce back to /setup (would happen if `['properties']` cache stale)
 */
setup('authenticate owner + complete 2-step onboarding wizard', async ({ page }, setupInfo) => {
	const ts = Date.now()
	const workerIdx = setupInfo.workerIndex
	const email = `e2e-owner-${ts}-w${workerIdx}@sochi.local`
	const password = 'playwright-e2e-01'
	const orgName = `E2E Hotel ${ts} W${workerIdx}`

	// --- Signup ---
	await page.goto('/signup')
	await expect(page.getByRole('heading', { name: 'Регистрация' })).toBeVisible()

	await page.getByLabel('Ваше имя').fill('E2E Owner')
	await page.getByLabel('Email').fill(email)
	await page.getByLabel('Пароль').fill(password)
	await page.getByLabel('Название гостиницы').fill(orgName)
	await page.getByLabel(/согласие/).check()

	await page.getByRole('button', { name: 'Создать аккаунт' }).click()

	// Empty-tenant dashboard redirects to wizard — URL lands на /setup.
	await expect(page).toHaveURL(/\/o\/e2e-hotel-\d+\/setup$/)
	const match = page.url().match(/\/o\/([^/?]+)\/setup$/)
	const orgSlug = match?.[1] ?? ''
	expect(orgSlug.length).toBeGreaterThan(0)

	// --- Screen 1: identify (ИНН lookup) ---
	await expect(page.getByRole('heading', { name: 'Заводим гостиницу' })).toBeVisible()
	// Progress indicator: first step active, second inactive.
	await expect(page.locator('li[aria-current="step"]')).toContainText('Гостиница')

	const innInput = page.getByLabel('ИНН гостиницы')
	await expect(innInput).toBeVisible()
	// Adversarial: Найти button disabled on empty / malformed ИНН.
	await expect(page.getByRole('button', { name: 'Найти' })).toBeDisabled()
	await innInput.fill('232') // partial — still invalid (need 10/12 digits)
	await expect(page.getByRole('button', { name: 'Найти' })).toBeDisabled()
	// Canonical demo ИНН from backend mock-dadata.ts → ООО «Демо-Сириус».
	await innInput.fill('2320000001')
	await expect(page.getByRole('button', { name: 'Найти' })).toBeEnabled()
	await page.getByRole('button', { name: 'Найти' }).click()

	// Preview card visible with the canonical demo party fields. The
	// `aria-label="Найденная организация"` is the canonical attachment point
	// (party-preview-card.tsx).
	const preview = page.getByRole('complementary', { name: 'Найденная организация' })
	await expect(preview).toBeVisible()
	await expect(preview).toContainText('ООО «Демо-Сириус»')
	await expect(preview).toContainText('2320000001')
	await expect(preview).toContainText('УСН «Доходы» (6%)')
	await expect(preview).toContainText('Действующая')

	// Advance to Screen 2.
	await page.getByRole('button', { name: /Подтвердить/ }).click()

	// --- Screen 2: inventory (rooms + price) ---
	await expect(page.locator('li[aria-current="step"]')).toContainText('Номера и цена')

	const roomsInput = page.getByLabel('Сколько номеров?')
	const priceInput = page.getByLabel('Цена за ночь, ₽')
	// Canonical defaults from wizard-store INITIAL: 10 rooms × 3500 ₽.
	await expect(roomsInput).toHaveValue('10')
	await expect(priceInput).toHaveValue('3500')

	// Reference of the canonical party rendered as compact read-only badge
	// (NOT the manual fieldset — usingManual must be false here).
	await expect(page.getByText('ООО «Демо-Сириус»')).toBeVisible()
	await expect(page.getByLabel('Название')).toHaveCount(0)

	// Готово → submit. Wait for navigation BEFORE clicking via `Promise.all`
	// to capture the redirect deterministically.
	await Promise.all([
		page.waitForURL(/\/o\/[^/]+\/grid$/),
		page.getByRole('button', { name: /Готово/ }).click(),
	])

	// --- Grid landing — empirical end-to-end gate ---
	// Without these assertions «wizard succeeded» is trust-me; with them it's
	// proven that property + roomType + ratePlan really committed AND the
	// dashboard cache eviction worked (no /setup bounce).
	await expect(page.getByRole('rowheader', { name: 'Стандартный' })).toBeVisible()
	// 15 date columns + 1 row-header column = 16. Stable canon shared с
	// grid-a11y.spec.ts и existing chromium tests.
	await expect(page.getByRole('grid')).toHaveAttribute('aria-colcount', '16')

	await page.context().storageState({ path: `tests/.auth/owner-w${workerIdx}.json` })
})
