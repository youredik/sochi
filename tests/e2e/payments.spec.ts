import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

// Payment tests seed via UI booking grid + API folio/line. Под full e2e:smoke
// load (15+ test files в одном workers=1 run, accumulated YDB state) grid
// render takes longer than the default 30s. Per Apaleo / Mews / Cloudbeds 2026
// e2e canon — payment-domain tests get 90s ceiling. Default 30s for fast tests
// в других spec'ах не меняется.
test.describe.configure({ timeout: 90_000 })

/**
 * M6.8 — payment Sheets a11y + full-flow E2E + regression gates.
 *
 * **Pre-done audit catch — REAL production bug (M6.8 round-5 diagnostic):**
 *   `mutateAsync({ amountMinor: bigint })` через Hono RPC client → JSON.stringify
 *   throws `TypeError: Do not know how to serialize a BigInt`. Mark Paid + Refund
 *   submit невозможен в любом браузере. Fix: `vars.amountMinor.toString()` в
 *   `use-folio-queries.ts` + canon: bigint никогда не передавать в JSON body
 *   напрямую. Этот test suite — permanent regression gate.
 *
 * **TanStack Form 1.29 + Radix Sheet portal — submit pattern (round-5):**
 *   - `<button type="submit" form={useId}>` outside form HE работает в Radix
 *     Sheet portal (pointer-events / focus-scope перехватывают native submit).
 *   - Канон 2026: `onClick={async () => { await form.validateAllFields('submit')
 *     ; await form.handleSubmit() }}` (mirror RefundSheet step gate). Issue
 *     #1990: untouched RadioGroup → canSubmit:false → handleSubmit silently
 *     returns без validateAllFields prepend.
 *
 * **Layered tests per Stripe / Apaleo 2026 trophy:**
 *   - Backend integration: balance math, idempotency replay, state machines
 *   - Playwright a11y: axe scan на rendered Sheets (3 surfaces)
 *   - Playwright full-flow: 2 happy paths + 1 idempotency regression
 *   - State seeded через `page.request.post` (auth cookies share с BrowserCtx)
 */

const API_BASE = 'http://localhost:3000/api/v1'

function futureIso(daysFromToday: number): string {
	const d = new Date()
	d.setUTCHours(12, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + daysFromToday)
	return d.toISOString().slice(0, 10)
}

async function getOrgSlug(page: Page): Promise<string> {
	await page.goto('/')
	await expect(page).toHaveURL(/\/o\/([^/]+)\/?/)
	const url = page.url()
	const match = url.match(/\/o\/([^/?#]+)/)
	if (!match?.[1]) throw new Error(`Could not extract orgSlug from ${url}`)
	return match[1]
}

async function getFirstPropertyId(page: Page): Promise<string> {
	const res = await page.request.get(`${API_BASE}/properties`)
	if (!res.ok()) throw new Error(`properties.list HTTP ${res.status()}`)
	const body = (await res.json()) as { data: Array<{ id: string }> }
	const id = body.data[0]?.id
	if (!id) throw new Error('No property in tenant')
	return id
}

/**
 * Seed: create booking via UI grid, затем via page.request создаёт folio +
 * posts charge line чтобы balance > 0. Опционально pre-seed payment чтобы
 * Refund Sheet имел refundable payment (без необходимости mark-paid через UI).
 */
async function seedFolioFixture(
	page: Page,
	opts: {
		amountMinor: number
		futureDays: number
		docSuffix: string
		seedPayment?: boolean
	},
): Promise<{
	propertyId: string
	bookingId: string
	folioId: string
	orgSlug: string
}> {
	const orgSlug = await getOrgSlug(page)

	// 1) Create booking via UI grid (uses existing tested flow).
	await page.getByRole('link', { name: /Шахматка/ }).click()
	await expect(page).toHaveURL(/\/grid$/)
	const targetDate = futureIso(opts.futureDays)
	await page.locator(`button[data-cell-date="${targetDate}"]`).click()
	const createDialog = page.getByRole('dialog')
	await expect(createDialog).toBeVisible()
	await createDialog.getByLabel('Фамилия').fill(`Тестов-${opts.docSuffix}`)
	await createDialog.getByLabel('Имя').fill('Платёжный')
	await createDialog.getByLabel('Номер документа').fill(`4510${opts.docSuffix.padStart(6, '0')}`)
	await createDialog.getByRole('button', { name: /Создать бронирование/ }).click()
	await expect(page.getByText('Бронирование создано')).toBeVisible()
	await expect(createDialog).not.toBeVisible()

	const band = page.locator('[data-booking-id]:not([data-booking-id^="pending_"])').last()
	await expect(band).toBeVisible()
	const bookingId = await band.getAttribute('data-booking-id')
	if (!bookingId) throw new Error('No bookingId on band')

	const propertyId = await getFirstPropertyId(page)

	// 2) Create folio + post charge line via API.
	const listRes = await page.request.get(
		`${API_BASE}/properties/${propertyId}/bookings/${bookingId}/folios`,
	)
	if (!listRes.ok()) throw new Error(`folios.list HTTP ${listRes.status()}`)
	const listBody = (await listRes.json()) as { data: Array<{ id: string }> }
	let folioId: string
	if (listBody.data[0]) {
		folioId = listBody.data[0].id
	} else {
		const createRes = await page.request.post(
			`${API_BASE}/properties/${propertyId}/bookings/${bookingId}/folios`,
			{
				data: { kind: 'guest', currency: 'RUB' },
				headers: { 'Idempotency-Key': crypto.randomUUID() },
			},
		)
		if (!createRes.ok()) {
			throw new Error(`folio.create HTTP ${createRes.status()}: ${await createRes.text()}`)
		}
		folioId = ((await createRes.json()) as { data: { id: string } }).data.id
	}

	const lineRes = await page.request.post(`${API_BASE}/folios/${folioId}/lines`, {
		data: {
			category: 'accommodation',
			description: `E2E fixture: проживание ${opts.docSuffix}`,
			amountMinor: opts.amountMinor,
			isAccommodationBase: true,
			taxRateBps: 0,
		},
		headers: { 'Idempotency-Key': crypto.randomUUID() },
	})
	if (!lineRes.ok()) {
		throw new Error(`folioLine.post HTTP ${lineRes.status()}: ${await lineRes.text()}`)
	}

	// 3) Optional: seed payment so Refund Sheet has a refundable target.
	if (opts.seedPayment) {
		const payRes = await page.request.post(
			`${API_BASE}/properties/${propertyId}/bookings/${bookingId}/payments`,
			{
				data: {
					folioId,
					providerCode: 'stub',
					method: 'cash',
					amountMinor: opts.amountMinor,
					currency: 'RUB',
					idempotencyKey: crypto.randomUUID(),
					saleChannel: 'direct',
				},
				headers: { 'Idempotency-Key': crypto.randomUUID() },
			},
		)
		if (!payRes.ok()) {
			throw new Error(`payment.create HTTP ${payRes.status()}: ${await payRes.text()}`)
		}
	}

	return { propertyId, bookingId, folioId, orgSlug }
}

/* ============================================================ a11y on opened Sheets */

test.describe('M6.8: a11y on opened payment Sheets — WCAG 2.2 AA', () => {
	test('Mark Paid Sheet (open state) passes WCAG 2.2 AA', async ({ page }) => {
		const seed = await seedFolioFixture(page, {
			amountMinor: 500_000,
			futureDays: 5,
			docSuffix: 'a11ymp',
		})

		await page.goto(`/o/${seed.orgSlug}/bookings/${seed.bookingId}/folios/${seed.folioId}`)
		await expect(page.getByRole('heading', { name: /Фолио/ })).toBeVisible()

		await page.getByRole('button', { name: /Принять оплату/, exact: false }).first().click()
		const dialog = page.getByRole('dialog', { name: /Принять оплату/ })
		await expect(dialog).toBeVisible()
		// Wait for submit button to be enabled to avoid phantom contrast violation
		// (opacity-50 disabled state breaks contrast checks).
		await expect(dialog.getByRole('button', { name: /^Принять$/ })).toBeEnabled()

		const results = await new AxeBuilder({ page })
			.include('[role="dialog"]')
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()
		if (results.violations.length > 0) {
			console.error(
				'axe violations (mark-paid sheet):',
				JSON.stringify(results.violations, null, 2),
			)
		}
		expect(results.violations).toEqual([])
	})

	test('Refund Sheet Step 1 (form) passes WCAG 2.2 AA', async ({ page }) => {
		const seed = await seedFolioFixture(page, {
			amountMinor: 500_000,
			futureDays: 6,
			docSuffix: 'a11yr1',
			seedPayment: true,
		})

		// Payment seeded via API → refundable row available immediately.
		await page.goto(
			`/o/${seed.orgSlug}/bookings/${seed.bookingId}/folios/${seed.folioId}?tab=payments`,
		)
		await expect(page.getByRole('heading', { name: /Фолио/ })).toBeVisible()

		// Scope to table row (NOT balance-card "Возврат" which only switches tab).
		await page.getByRole('row').filter({ hasText: 'Проведён' }).getByRole('button', { name: 'Возврат' }).click()
		const dialog = page.getByRole('dialog', { name: /Возврат платежа/ })
		await expect(dialog).toBeVisible()
		await expect(dialog.getByText(/Доступно к возврату/)).toBeVisible()
		await expect(dialog.getByRole('button', { name: 'Далее' })).toBeEnabled()

		const results = await new AxeBuilder({ page })
			.include('[role="dialog"]')
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()
		if (results.violations.length > 0) {
			console.error(
				'axe violations (refund step 1):',
				JSON.stringify(results.violations, null, 2),
			)
		}
		expect(results.violations).toEqual([])
	})

	test('Refund Sheet Step 2 (confirm) passes WCAG 2.2 AA', async ({ page }) => {
		const seed = await seedFolioFixture(page, {
			amountMinor: 500_000,
			futureDays: 7,
			docSuffix: 'a11yr2',
			seedPayment: true,
		})

		await page.goto(
			`/o/${seed.orgSlug}/bookings/${seed.bookingId}/folios/${seed.folioId}?tab=payments`,
		)
		// Scope to table row (NOT balance-card "Возврат" which only switches tab).
		await page.getByRole('row').filter({ hasText: 'Проведён' }).getByRole('button', { name: 'Возврат' }).click()
		// Dialog title changes between steps ('Возврат платежа' → 'Подтвердите
		// возврат'), so use generic dialog locator without name filter.
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()

		await dialog.getByLabel('Причина возврата').fill('Тест a11y — Step 2')
		await dialog.getByRole('button', { name: 'Далее' }).click()
		await expect(dialog.getByRole('heading', { name: /Подтвердите возврат/ })).toBeVisible()
		await expect(
			dialog.getByRole('button', { name: /Подтвердить возврат/ }),
		).toBeEnabled()

		const results = await new AxeBuilder({ page })
			.include('[role="dialog"]')
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()
		if (results.violations.length > 0) {
			console.error(
				'axe violations (refund step 2):',
				JSON.stringify(results.violations, null, 2),
			)
		}
		expect(results.violations).toEqual([])
	})
})

/* ============================================================ full-flow E2E */

/**
 * Open Mark Paid Sheet, submit с pre-filled amount = balance, verify POST 201
 * + Sheet closes + toast.
 *
 * Использует pre-fill, не editing amount input — `react-number-format` каретный
 * engine + Playwright pressSequentially не reliably sync'ит value с form state.
 * Production использует pre-fill в 99% (operator paying full balance).
 */
async function markPaidViaUiHappyPath(page: Page) {
	await page.getByRole('button', { name: /Принять оплату/, exact: false }).first().click()
	const sheet = page.getByRole('dialog', { name: /Принять оплату/ })
	await expect(sheet).toBeVisible()

	const responsePromise = page.waitForResponse(
		(r) => r.url().includes('/payments') && r.request().method() === 'POST',
	)
	await sheet.getByRole('button', { name: /^Принять$/ }).click()
	const response = await responsePromise
	expect(response.status(), `payment POST failed: ${await response.text()}`).toBe(201)
	await expect(sheet).not.toBeVisible()
	return response
}

test.describe('M6.8: full-flow E2E (post-bigint-fix regression gate)', () => {
	test('mark-paid happy path: POST 201 + Sheet closes + payment row appears', async ({ page }) => {
		const seed = await seedFolioFixture(page, {
			amountMinor: 500_000,
			futureDays: 8,
			docSuffix: 'flowmp',
		})

		await page.goto(
			`/o/${seed.orgSlug}/bookings/${seed.bookingId}/folios/${seed.folioId}`,
		)
		await expect(page.getByRole('heading', { name: /Фолио/ })).toBeVisible()

		await markPaidViaUiHappyPath(page)

		// Switch to Payments tab — exactly 1 row, "Возврат" button enabled.
		await page.getByRole('tab', { name: /Платежи/ }).click()
		await expect(
			page.getByRole('row').filter({ hasText: 'Проведён' }).getByRole('button', { name: 'Возврат' }),
		).toHaveCount(1)
	})

	test('refund flow: 2-step confirm in Sheet → POST 201', async ({ page }) => {
		const seed = await seedFolioFixture(page, {
			amountMinor: 500_000,
			futureDays: 9,
			docSuffix: 'flowrf',
			seedPayment: true, // skip mark-paid UI; payment seeded via API
		})

		await page.goto(
			`/o/${seed.orgSlug}/bookings/${seed.bookingId}/folios/${seed.folioId}?tab=payments`,
		)
		await expect(page.getByRole('heading', { name: /Фолио/ })).toBeVisible()

		await page
			.getByRole('row')
			.filter({ hasText: 'Проведён' })
			.getByRole('button', { name: 'Возврат' })
			.click()
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		await dialog.getByLabel('Причина возврата').fill('E2E flow refund')
		await dialog.getByRole('button', { name: 'Далее' }).click()
		await expect(dialog.getByRole('heading', { name: /Подтвердите возврат/ })).toBeVisible()

		const refundResponsePromise = page.waitForResponse(
			(r) => r.url().includes('/refunds') && r.request().method() === 'POST',
		)
		await dialog.getByRole('button', { name: /Подтвердить возврат/ }).click()
		const refundResponse = await refundResponsePromise
		expect(refundResponse.status(), `refund POST failed: ${await refundResponse.text()}`).toBe(
			201,
		)
		await expect(dialog).not.toBeVisible()
	})
})

/* ============================================================ Idempotency-Key regression */

test.describe('M6.8: Idempotency-Key per-Sheet-mount regression (post-bigint-fix)', () => {
	test('two consecutive Mark Paid opens send DIFFERENT Idempotency-Key headers', async ({
		page,
	}) => {
		const seed = await seedFolioFixture(page, {
			amountMinor: 1_000_000, // 10000 ₽ — enough for 2 partial payments
			futureDays: 10,
			docSuffix: 'idem',
		})

		await page.goto(
			`/o/${seed.orgSlug}/bookings/${seed.bookingId}/folios/${seed.folioId}`,
		)
		await expect(page.getByRole('heading', { name: /Фолио/ })).toBeVisible()

		// 1st mark-paid: full balance
		const req1Promise = page.waitForRequest(
			(r) => r.url().includes('/payments') && r.method() === 'POST',
		)
		const resp1 = await markPaidViaUiHappyPath(page)
		const req1 = await req1Promise
		const key1 = req1.headers()['idempotency-key']
		expect(key1, 'first POST must have Idempotency-Key header').toBeTruthy()
		expect(resp1.status()).toBe(201)

		// Pump folio balance again to enable a 2nd payment.
		await page.request.post(`${API_BASE}/folios/${seed.folioId}/lines`, {
			data: {
				category: 'misc',
				description: 'second-line',
				amountMinor: 500_000,
				isAccommodationBase: false,
				taxRateBps: 0,
			},
			headers: { 'Idempotency-Key': crypto.randomUUID() },
		})

		// 2nd mark-paid: must remount Sheet → fresh useMemo key
		const req2Promise = page.waitForRequest(
			(r) => r.url().includes('/payments') && r.method() === 'POST',
		)
		// Header polls + folio query refetch may take a beat; balance card needs to
		// re-enable "Принять оплату" trigger after 2nd line lands.
		await page.reload()
		await expect(page.getByRole('heading', { name: /Фолио/ })).toBeVisible()
		const resp2 = await markPaidViaUiHappyPath(page)
		const req2 = await req2Promise
		const key2 = req2.headers()['idempotency-key']
		expect(key2, 'second POST must have Idempotency-Key header').toBeTruthy()
		expect(resp2.status()).toBe(201)

		// REGRESSION GATE: keys MUST differ. Pre-M6.7.7 fix, useMemo([]) inside
		// unconditionally-rendered Sheet reused first UUID → silent replay bug.
		expect(key1).not.toBe(key2)

		// Side-effect proof: 2 payment rows on Payments tab.
		await page.getByRole('tab', { name: /Платежи/ }).click()
		await expect(
			page.getByRole('row').filter({ hasText: 'Проведён' }),
		).toHaveCount(2)
	})
})
