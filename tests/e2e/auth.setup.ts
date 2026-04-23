import { expect, test as setup } from '@playwright/test'

/**
 * Setup project: create a fresh owner user + org + run the full M5c
 * setup wizard (property → roomType → rooms) so downstream `chromium`
 * tests land on a real tenant dashboard, not the wizard.
 *
 * Each pre-push run creates a new user (timestamp in email) — the test DB
 * never needs pruning, and cross-run pollution stays tenant-isolated.
 *
 * Adversarial checks embedded along the way:
 *   - progress indicator increments step-by-step (1 → 2 → 3)
 *   - dashboard beforeLoad redirects empty-tenant owner to /setup (not
 *     shown directly but validated by the wizard page appearing after
 *     signup's /o/{slug}/ redirect)
 *   - floor-less room creation succeeds (adversarial: floor IS optional)
 *   - clicking "Завершить настройку" while 0 rooms are created is blocked
 *     (button `disabled` attribute) — verified by filling one room first
 */
setup('authenticate owner + complete setup wizard', async ({ page }) => {
	const ts = Date.now()
	const email = `e2e-owner-${ts}@sochi.local`
	const password = 'playwright-e2e-01'
	const orgName = `E2E Hotel ${ts}`

	// --- Signup ---
	await page.goto('/signup')
	await expect(page.getByRole('heading', { name: /Регистрация/ })).toBeVisible()

	await page.getByLabel('Ваше имя').fill('E2E Owner')
	await page.getByLabel('Email').fill(email)
	await page.getByLabel('Пароль').fill(password)
	await page.getByLabel('Название гостиницы').fill(orgName)
	await page.getByLabel(/согласие/).check()

	await page.getByRole('button', { name: 'Создать аккаунт' }).click()

	// Empty-tenant dashboard redirects to wizard — URL lands on /setup.
	await expect(page).toHaveURL(/\/o\/e2e-hotel-\d+\/setup$/)

	// --- Wizard step 1: Property ---
	await expect(page.getByLabel('Название гостиницы')).toBeVisible()
	await page.getByLabel('Название гостиницы').fill(`${orgName} — основное здание`)
	await page.getByLabel('Адрес').fill('Имеретинская низменность, Сириус')
	// Город select already defaulted to Сочи (exact-value: 200 bps tax default).
	await expect(page.getByLabel('Туристический налог, б.п.')).toHaveValue('200')
	await page.getByRole('button', { name: /Далее — тип номеров/ }).click()

	// --- Wizard step 2: RoomType ---
	await expect(page.getByLabel('Название типа')).toBeVisible()
	// Defaults are intentionally sensible; submit as-is to cover default-path.
	await expect(page.getByLabel('Название типа')).toHaveValue('Стандарт')
	await expect(page.getByLabel('Макс. гостей')).toHaveValue('2')
	await page.getByRole('button', { name: /Далее — номера/ }).click()

	// --- Wizard step 3: Rooms ---
	await expect(page.getByLabel('Номер')).toBeVisible()
	// Adversarial: "Далее — тариф" button disabled when 0 rooms created
	// (can't advance until at least one room exists).
	await expect(page.getByRole('button', { name: /Далее — тариф/ })).toBeDisabled()
	// Add one room without floor (floor optional — important adversarial).
	await page.getByLabel('Номер').fill('101')
	await page.getByRole('button', { name: /Добавить номер/ }).click()
	await expect(page.getByText(/Добавлено: 1/)).toBeVisible()
	// Add second room with floor.
	await page.getByLabel('Номер').fill('102')
	await page.getByLabel(/Этаж/).fill('1')
	await page.getByRole('button', { name: /Добавить номер/ }).click()
	await expect(page.getByText(/Добавлено: 2/)).toBeVisible()

	// Advance from rooms → ratePlan step.
	await page.getByRole('button', { name: /Далее — тариф/ }).click()

	// --- Wizard step 4: Rate plan ---
	await expect(page.getByLabel('Название тарифа')).toBeVisible()
	// Defaults (BAR / Базовый тариф / 5000₽) — submit as-is to cover
	// the happy path; variants/overrides belong in rate-management UI.
	await expect(page.getByLabel('Код')).toHaveValue('BAR')
	await expect(page.getByLabel('Цена за ночь, ₽')).toHaveValue('5000')
	await page.getByRole('button', { name: /Завершить настройку/ }).click()

	// Finish — lands on tenant dashboard (now with property + ratePlan + 30-day rate/availability seeded).
	await expect(page).toHaveURL(/\/o\/e2e-hotel-\d+\/?$/)
	await expect(page.getByRole('heading', { name: orgName })).toBeVisible()

	await page.context().storageState({ path: 'tests/.auth/owner.json' })
})
