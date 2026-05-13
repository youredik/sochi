import { expect } from '@playwright/test'
import { test } from './_fixtures.ts'

/**
 * Setup-wizard adversarial coverage (post-`0c31ecf` 2-screen wizard). Runs
 * under the `chromium` project с per-worker storageState — the owner has
 * already completed the wizard in `auth.setup.ts`, so the dashboard at
 * `/o/{slug}/` no longer redirects to /setup. Direct navigation to
 * `/o/{slug}/setup` is still reachable (the setup route has no «property
 * exists» guard, by design — it's an idempotent entry point), и the
 * wizard-store is fresh on every page load (in-memory Zustand, no
 * localStorage persistence).
 *
 * **Behaviour-faithful mocks per canon**: this spec exercises the real
 * production `dadata.mock` adapter (Playwright's `webServer.env` forces
 * `DADATA_API_KEY=''` so the factory binds to mock). All ИНН used below
 * are entries from the canonical `DEMO_COMPANIES` set in
 * `apps/backend/src/domains/identity/dadata/mock-dadata.ts` — no
 * HTTP-layer interception. Adding a new branch (e.g. REORGANIZING) means
 * adding a record to that file, not re-mocking at the test seam.
 *
 * Hunts NOT covered by `auth.setup.ts` happy path:
 *   - cross-tenant URL `/o/{otherSlug}/setup` redirects away (auth gate at
 *     parent `_app/o/$orgSlug` validates membership)
 *   - DaData null branch — wizard pivots to «Заполнить вручную»
 *   - DaData LIQUIDATED branch — Подтвердить blocked + role="alert" shown
 *   - invalid ИНН (9 digits / 11 digits / non-numeric stripped) — Найти
 *     stays disabled
 *   - wizard-store fresh on page reload (in-memory only, не localStorage-
 *     cached)
 */
test.describe('setup wizard adversarial (2-screen ИНН → inventory)', () => {
	test('cross-tenant URL /o/not-your-slug/setup redirects away', async ({ page }) => {
		await page.goto('/o/definitely-not-your-org/setup')
		// `_app/o/$orgSlug` guard: slug ∉ user.orgs → redirect к '/', which
		// resolves to the owner's own org. URL MUST NOT contain the adversarial
		// slug at any point past the initial navigation.
		await expect(page).not.toHaveURL(/definitely-not-your-org/)
	})

	test('wizard-store fresh on direct navigation (no localStorage persistence)', async ({
		page,
	}) => {
		// Land on the owner's setup route directly. wizard-store is in-memory
		// only — direct navigation MUST start at step 1 (identify), not step 2
		// (inventory) even if a prior session typed values.
		await page.goto('/')
		await expect(page).toHaveURL(/\/o\/e2e-hotel-\d+\/?$/)
		const slug = page.url().match(/\/o\/([^/?]+)/)?.[1] ?? ''
		expect(slug.length).toBeGreaterThan(0)

		await page.goto(`/o/${slug}/setup`)
		// Step 1 surface rendered.
		await expect(page.getByLabel('ИНН гостиницы')).toBeVisible()
		await expect(page.locator('li[aria-current="step"]')).toContainText('Гостиница')
		// Inventory inputs from step 2 absent.
		await expect(page.getByLabel('Сколько номеров?')).toHaveCount(0)
	})

	test('invalid ИНН keeps Найти disabled (10/12 digits regex enforced)', async ({ page }) => {
		await page.goto('/')
		const slug = page.url().match(/\/o\/([^/?]+)/)?.[1] ?? ''
		await page.goto(`/o/${slug}/setup`)

		const innInput = page.getByLabel('ИНН гостиницы')
		const submit = page.getByRole('button', { name: 'Найти' })

		await expect(submit).toBeDisabled()

		// 9 digits — below floor.
		await innInput.fill('123456789')
		await expect(submit).toBeDisabled()

		// 11 digits — between 10 and 12, both rejected by `(\d{10}|\d{12})`.
		await innInput.fill('12345678901')
		await expect(submit).toBeDisabled()

		// Non-numeric stripped client-side (identify-step onChange).
		await innInput.fill('abcdefghij')
		await expect(innInput).toHaveValue('')
		await expect(submit).toBeDisabled()

		// Valid 10-digit — enabled.
		await innInput.fill('2320000001')
		await expect(submit).toBeEnabled()
	})

	test('DaData LIQUIDATED party blocks Подтвердить + surfaces destructive banner', async ({
		page,
	}) => {
		await page.goto('/')
		const slug = page.url().match(/\/o\/([^/?]+)/)?.[1] ?? ''
		await page.goto(`/o/${slug}/setup`)

		// Canonical LIQUIDATED demo record from mock-dadata.ts (added 2026-05-13
		// as the adversarial fixture, lives in the production mock surface so
		// the public hosted demo can showcase this protection too).
		await page.getByLabel('ИНН гостиницы').fill('2320000099')
		await page.getByRole('button', { name: 'Найти' }).click()

		const preview = page.getByRole('complementary', { name: 'Найденная организация' })
		await expect(preview).toBeVisible()
		await expect(preview).toContainText('ООО «Демо-Ликвидированная»')
		await expect(preview).toContainText('Ликвидирована')

		// Подтвердить button rendered but DISABLED (liquidated branch).
		await expect(page.getByRole('button', { name: /Подтвердить/ })).toBeDisabled()
		// role="alert" banner present and contains the canon phrase.
		await expect(page.getByRole('alert')).toContainText(/ликвидирована|ликвидации/i)
	})

	test('DaData null pivots to manual fill — Заполнить вручную advances to Screen 2', async ({
		page,
	}) => {
		await page.goto('/')
		const slug = page.url().match(/\/o\/([^/?]+)/)?.[1] ?? ''
		await page.goto(`/o/${slug}/setup`)

		// 10-digit ИНН NOT in DEMO_COMPANIES → backend mock returns null
		// (mirrors the «unknown ИНН» branch the real DaData also hits).
		await page.getByLabel('ИНН гостиницы').fill('9999999990')
		await page.getByRole('button', { name: 'Найти' }).click()

		// «Не нашли» banner + Заполнить вручную CTA.
		const banner = page.getByRole('status')
		await expect(banner).toContainText('не найдена')

		await page.getByRole('button', { name: 'Заполнить вручную →' }).click()

		// Screen 2 with manual fieldset visible (usingManual=true branch).
		await expect(page.locator('li[aria-current="step"]')).toContainText('Номера и цена')
		await expect(page.getByRole('group', { name: 'Данные гостиницы' })).toBeVisible()
		await expect(page.getByLabel('Название')).toBeVisible()
		await expect(page.getByLabel('Адрес')).toBeVisible()
		await expect(page.getByLabel('Город')).toBeVisible()
	})
})
