import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

// API-only seed (no UI grid traversal) keeps payment specs deterministic под
// full e2e:smoke load. Ranged-day bookings (15+ days в будущем) не пересекаются
// с bookings.spec.ts (futureDays 1-10) — нет inventory contention. 60s timeout
// достаточен для UI navigation + axe scan; seed теперь O(API roundtrips), не
// O(grid render).
test.describe.configure({ timeout: 60_000 })

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
 * Seed via API-only chain (NO UI grid traversal):
 *   1. List roomTypes + ratePlans (auth.setup wizard pre-seeds 1 of each)
 *   2. POST /guests — create primary guest
 *   3. POST /properties/:p/bookings — create booking (1 night)
 *   4. Poll-list /folios (M7.A.1 CDC auto-creates) или explicit POST fallback
 *   5. POST /folios/:f/lines — pump balance
 *   6. (optional) POST /payments — pre-seed для Refund Sheet
 *
 * Deterministic + ~5x faster than UI flow + no Шахматка inventory contention
 * с bookings.spec.ts (futureDays 1-10 → этот suite 15-20).
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
	const propertyId = await getFirstPropertyId(page)

	// 1. Pull roomType + ratePlan (auth.setup created exactly one of each).
	const [roomTypesRes, ratePlansRes] = await Promise.all([
		page.request.get(`${API_BASE}/properties/${propertyId}/room-types`),
		page.request.get(`${API_BASE}/properties/${propertyId}/rate-plans`),
	])
	if (!roomTypesRes.ok()) throw new Error(`roomTypes.list HTTP ${roomTypesRes.status()}`)
	if (!ratePlansRes.ok()) throw new Error(`ratePlans.list HTTP ${ratePlansRes.status()}`)
	const roomTypeId = ((await roomTypesRes.json()) as { data: Array<{ id: string }> }).data[0]?.id
	const ratePlanId = ((await ratePlansRes.json()) as { data: Array<{ id: string }> }).data[0]?.id
	if (!roomTypeId) throw new Error('seed: no roomType in tenant (wizard fixture missing)')
	if (!ratePlanId) throw new Error('seed: no ratePlan in tenant (wizard fixture missing)')

	// 2. Create guest (passport snapshot mirrors UI dialog for канон parity).
	const lastName = `Тестов-${opts.docSuffix}`
	const firstName = 'Платёжный'
	const documentNumber = `4510${opts.docSuffix.padStart(6, '0')}`
	const guestRes = await page.request.post(`${API_BASE}/guests`, {
		data: {
			lastName,
			firstName,
			citizenship: 'RU',
			documentType: 'passport',
			documentNumber,
		},
	})
	if (!guestRes.ok()) {
		throw new Error(`guest.create HTTP ${guestRes.status()}: ${await guestRes.text()}`)
	}
	const guestId = ((await guestRes.json()) as { data: { id: string } }).data.id

	// 3. Create booking (1-night, walkIn channel — no OTA gate).
	const checkIn = futureIso(opts.futureDays)
	const checkOut = futureIso(opts.futureDays + 1)
	const bookingRes = await page.request.post(
		`${API_BASE}/properties/${propertyId}/bookings`,
		{
			data: {
				roomTypeId,
				ratePlanId,
				checkIn,
				checkOut,
				guestsCount: 1,
				primaryGuestId: guestId,
				guestSnapshot: {
					firstName,
					lastName,
					citizenship: 'RU',
					documentType: 'passport',
					documentNumber,
				},
				channelCode: 'walkIn',
			},
		},
	)
	if (!bookingRes.ok()) {
		throw new Error(`booking.create HTTP ${bookingRes.status()}: ${await bookingRes.text()}`)
	}
	const bookingId = ((await bookingRes.json()) as { data: { id: string } }).data.id

	// 4. Folio: M7.A.1 CDC consumer auto-creates async after booking INSERT.
	// Poll up to 5s; fallback to explicit POST if CDC slow (race-safe — repo
	// has UNIQUE(bookingId), explicit create returns 409 if CDC won → still
	// usable via the list path on next iteration).
	let folioId: string | undefined
	const pollDeadline = Date.now() + 5_000
	while (Date.now() < pollDeadline) {
		const listRes = await page.request.get(
			`${API_BASE}/properties/${propertyId}/bookings/${bookingId}/folios`,
		)
		if (!listRes.ok()) throw new Error(`folios.list HTTP ${listRes.status()}`)
		const listBody = (await listRes.json()) as { data: Array<{ id: string }> }
		if (listBody.data[0]) {
			folioId = listBody.data[0].id
			break
		}
		await page.waitForTimeout(150)
	}
	if (!folioId) {
		// CDC didn't fire within 5s — explicit fallback (deterministic seed).
		const createRes = await page.request.post(
			`${API_BASE}/properties/${propertyId}/bookings/${bookingId}/folios`,
			{
				data: { kind: 'guest', currency: 'RUB' },
				headers: { 'Idempotency-Key': crypto.randomUUID() },
			},
		)
		if (!createRes.ok()) {
			// Race: CDC created folio between our last poll and POST → list now.
			const listRes = await page.request.get(
				`${API_BASE}/properties/${propertyId}/bookings/${bookingId}/folios`,
			)
			const listBody = (await listRes.json()) as { data: Array<{ id: string }> }
			if (!listBody.data[0]) {
				throw new Error(
					`folio.create HTTP ${createRes.status()}: ${await createRes.text()} (and list returned empty)`,
				)
			}
			folioId = listBody.data[0].id
		} else {
			folioId = ((await createRes.json()) as { data: { id: string } }).data.id
		}
	}

	// 5. Pump folio balance.
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

	// 6. Optional: seed payment so Refund Sheet has a refundable target.
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
			futureDays: 15,
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
			futureDays: 16,
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
			futureDays: 17,
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
			futureDays: 18,
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
			futureDays: 19,
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
			futureDays: 20,
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
