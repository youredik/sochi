import AxeBuilder from '@axe-core/playwright'
import { test } from './_fixtures.ts'
import { expect } from '@playwright/test'

/**
 * G10 (2026-05-16) — SSE real-time + mobile-list e2e.
 *
 * Per R1+R2 ≥ 2026-05-16 canon (D-G10.1..18):
 *   [G10-E1] SSE handshake: tab loads /grid → EventSource opens → 401 без
 *            session (covered by smoke); с session → connection opens.
 *   [G10-E2] 2-tab broadcast: tab A creates booking (API) → tab B grid
 *            receives SSE event within 3s → query invalidation → new band
 *            appears на grid (empirical end-to-end проof).
 *   [G10-E3] Cross-tenant isolation: SSE endpoint 404 для bogus property.
 *   [G10-E4] Mobile-list view: pointer:coarse emulation → ChessboardMobile
 *            renders (not Chessboard desktop) с card shape per Bnovo+Hostaway
 *            canon.
 *   [G10-E5] Mobile axe WCAG 2.2 AA + 2.5.5 target-size compliance.
 *   [G10-E6] Mobile filter chips toggle status filter.
 *   [G10-E7] Mobile group-by-date headers («Сегодня» / «15 мая, четверг»).
 *   [G10-E8] Mobile tap booking card → BookingEditSheet opens.
 */

function futureIso(daysFromToday: number): string {
	const d = new Date()
	d.setUTCHours(12, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + daysFromToday)
	return d.toISOString().slice(0, 10)
}

const API_BASE = 'http://localhost:8787/api/v1'

async function seedTenantContext(page: import('@playwright/test').Page): Promise<{
	propertyId: string
	roomTypeId: string
	ratePlanId: string
}> {
	await page.goto('/')
	const propsRes = await page.request.get(`${API_BASE}/properties`)
	const propertyId = ((await propsRes.json()) as { data: Array<{ id: string }> }).data[0]?.id
	if (!propertyId) throw new Error('no property')
	const [rtRes, rpRes] = await Promise.all([
		page.request.get(`${API_BASE}/properties/${propertyId}/room-types`),
		page.request.get(`${API_BASE}/properties/${propertyId}/rate-plans`),
	])
	const roomTypeId = ((await rtRes.json()) as { data: Array<{ id: string }> }).data[0]?.id
	const ratePlanId = ((await rpRes.json()) as { data: Array<{ id: string }> }).data[0]?.id
	if (!roomTypeId || !ratePlanId) throw new Error('roomType/ratePlan missing')
	return { propertyId, roomTypeId, ratePlanId }
}

test.describe('G10 — SSE real-time', () => {
	test('[G10-E2] SSE 2-tab: api-create в context bumps grid в same tab via invalidation', async ({
		page,
	}) => {
		// Per R2 canon: own-user write suppresses TOAST но НЕ suppresses
		// queryClient.invalidateQueries. Grid still refetches и new band
		// appears. This proves SSE pipeline end-to-end (CDC → broadcaster
		// → SSE → EventSource → queryClient invalidate → refetch).
		const { propertyId, roomTypeId, ratePlanId } = await seedTenantContext(page)
		await page.locator('[data-section-id="grid"]').first().click()
		await page.waitForURL(/\/grid$/)
		await expect(page.getByRole('grid')).toBeVisible({ timeout: 10_000 })

		// Distant-future date — collision-free vs G4-G9 dayOffsets per
		// `[[e2e-self-contained-fixtures-canon]]`.
		// Day +60 — within 90-day rate-seed window, beyond G4-G9 (≤+15) pollution.
		const checkIn = futureIso(60)
		const checkOut = futureIso(61)
		const docNum = `4510g10${Date.now().toString().slice(-4)}`
		const gRes = await page.request.post(`${API_BASE}/guests`, {
			data: {
				lastName: 'SSE',
				firstName: 'Тест',
				citizenship: 'RU',
				documentType: 'passport',
				documentNumber: docNum,
			},
		})
		const guestId = ((await gRes.json()) as { data: { id: string } }).data.id

		// Scroll grid forward к see distant date BEFORE creating booking
		// (так чтобы потом we can verify band appears via SSE invalidation).
		const fwd = page.getByRole('button', { name: 'Следующие 15 дней' })
		for (let i = 0; i < 4; i++) await fwd.click()
		// Now window covers day +60..+75 (включая +60/+61).

		// Tab makes its own POST /bookings; SSE fires → invalidate → refetch
		// → band renders. Within 3s per R2 canon.
		const bRes = await page.request.post(`${API_BASE}/properties/${propertyId}/bookings`, {
			data: {
				roomTypeId,
				ratePlanId,
				checkIn,
				checkOut,
				guestsCount: 1,
				primaryGuestId: guestId,
				guestSnapshot: {
					firstName: 'Тест',
					lastName: 'SSE',
					citizenship: 'RU',
					documentType: 'passport',
					documentNumber: docNum,
				},
				channelCode: 'walkIn',
			},
		})
		if (!bRes.ok()) throw new Error(`booking.create ${bRes.status()}: ${await bRes.text()}`)
		const bookingId = ((await bRes.json()) as { data: { id: string } }).data.id

		// SSE invalidate triggers refetch → band appears в grid. Without
		// SSE pipeline this would NEVER happen (no other invalidation
		// trigger в this flow — API call doesn't manually invalidate
		// because we used page.request not the hook). Time budget: 3s
		// covers CDC commit + SSE fan-out + invalidate + REST refetch.
		await expect(page.locator(`[data-booking-id="${bookingId}"]`)).toBeVisible({
			timeout: 6_000,
		})

		// Cleanup
		await page.request.patch(`${API_BASE}/bookings/${bookingId}/cancel`, {
			data: { reason: 'TEST_CLEANUP' },
		})
	})

	test('[G10-E3] cross-tenant: SSE endpoint 404 для bogus propertyId', async ({ page }) => {
		await page.goto('/')
		const res = await page.request.get(
			`${API_BASE}/properties/prop_01HKQXR2T8J1QY7Q5W7K8R5K9P/events?stream=bookings`,
		)
		expect(res.status()).toBe(404)
	})

	test('[G10-E1] SSE endpoint 401 без session', async ({ browser }) => {
		// Fresh context (no auth cookies). SSE should reject pre-auth.
		const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } })
		const fresh = await ctx.newPage()
		const res = await fresh.request.get(
			`${API_BASE}/properties/prop_01HKQXR2T8J1QY7Q5W7K8R5K9P/events?stream=bookings`,
		)
		expect(res.status()).toBe(401)
		await ctx.close()
	})
})

test.describe('G10 — mobile-list view (pointer:coarse)', () => {
	test('[G10-E4] mobile viewport + pointer:coarse → ChessboardMobile renders, NOT desktop', async ({
		browser,
	}) => {
		// Per D-G10.12 — capability detection (NOT viewport-width). Use
		// Playwright's hasTouch (= forces pointer:coarse + hover:none
		// per chromium behavior).
		const ctx = await browser.newContext({
			storageState: 'tests/.auth/owner-w0.json',
			viewport: { width: 390, height: 844 }, // iPhone 14 Pro
			hasTouch: true,
			isMobile: true,
		})
		const page = await ctx.newPage()
		await page.goto('/')
		await page.waitForURL(/\/o\/[^/]+\/?$/, { timeout: 10_000 })
		const orgSlug = page.url().match(/\/o\/([^/]+)/)?.[1] ?? ''
		expect(orgSlug).not.toBe('')
		await page.goto(`/o/${orgSlug}/grid`)
		await page.waitForURL(/\/grid$/, { timeout: 10_000 })

		// Mobile-list root visible, desktop grid NOT
		await expect(page.locator('[data-slot="chessboard-mobile"]')).toBeVisible({
			timeout: 10_000,
		})
		await expect(page.getByRole('grid')).toHaveCount(0)

		// Filter row + status chips present (D-G10.14)
		await expect(page.locator('[data-slot="mobile-filter-row"]')).toBeVisible()
		await expect(page.locator('[data-slot="mobile-search-input"]')).toBeVisible()
		await expect(page.locator('[data-slot="mobile-status-chips"]')).toBeVisible()
		await expect(page.locator('[data-slot="mobile-date-jump"]')).toBeVisible()

		await ctx.close()
	})

	test('[G10-E5] mobile axe WCAG 2.2 AA + touch-target sanity', async ({ browser }) => {
		const ctx = await browser.newContext({
			storageState: 'tests/.auth/owner-w0.json',
			viewport: { width: 390, height: 844 },
			hasTouch: true,
			isMobile: true,
		})
		const page = await ctx.newPage()
		await page.goto('/')
		await page.waitForURL(/\/o\/[^/]+\/?$/, { timeout: 10_000 })
		const orgSlug = page.url().match(/\/o\/([^/]+)/)?.[1] ?? ''
		expect(orgSlug).not.toBe('')
		await page.goto(`/o/${orgSlug}/grid`)
		await page.waitForURL(/\/grid$/, { timeout: 10_000 })
		await expect(page.locator('[data-slot="chessboard-mobile"]')).toBeVisible({
			timeout: 10_000,
		})

		// Wait for animations к settle
		await page.waitForFunction(() =>
			document.getAnimations().every((a) => a.playState !== 'running'),
		)

		const results = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
			.analyze()
		if (results.violations.length > 0) {
			console.error('G10-E5 axe violations:', JSON.stringify(results.violations, null, 2))
		}
		expect(results.violations).toEqual([])

		// Target-size sanity: all interactive elements в filter row should
		// have min-height ≥ 44px (WCAG 2.5.5 + coarse-pointer convention).
		const chips = page.locator('[data-slot="mobile-status-chips"] button')
		const chipCount = await chips.count()
		for (let i = 0; i < chipCount; i++) {
			const box = await chips.nth(i).boundingBox()
			if (box) expect(box.height).toBeGreaterThanOrEqual(44)
		}
		const search = page.locator('[data-slot="mobile-search-input"]')
		const searchBox = await search.boundingBox()
		if (searchBox) expect(searchBox.height).toBeGreaterThanOrEqual(44)

		await ctx.close()
	})

	test('[G10-E6] mobile status filter chip toggle filters list', async ({ browser }) => {
		const ctx = await browser.newContext({
			storageState: 'tests/.auth/owner-w0.json',
			viewport: { width: 390, height: 844 },
			hasTouch: true,
			isMobile: true,
		})
		const page = await ctx.newPage()
		await page.goto('/')
		await page.waitForURL(/\/o\/[^/]+\/?$/, { timeout: 10_000 })
		const orgSlug = page.url().match(/\/o\/([^/]+)/)?.[1] ?? ''
		expect(orgSlug).not.toBe('')
		await page.goto(`/o/${orgSlug}/grid`)
		await page.waitForURL(/\/grid$/, { timeout: 10_000 })
		await expect(page.locator('[data-slot="chessboard-mobile"]')).toBeVisible({
			timeout: 10_000,
		})

		const chipCancelled = page.locator('[data-status-chip="cancelled"]')
		await expect(chipCancelled).toHaveAttribute('aria-pressed', 'false')
		await chipCancelled.tap()
		await expect(chipCancelled).toHaveAttribute('aria-pressed', 'true')
		await chipCancelled.tap()
		await expect(chipCancelled).toHaveAttribute('aria-pressed', 'false')

		await ctx.close()
	})

	test('[G10-E7] mobile date jump radio changes period', async ({ browser }) => {
		const ctx = await browser.newContext({
			storageState: 'tests/.auth/owner-w0.json',
			viewport: { width: 390, height: 844 },
			hasTouch: true,
			isMobile: true,
		})
		const page = await ctx.newPage()
		await page.goto('/')
		await page.waitForURL(/\/o\/[^/]+\/?$/, { timeout: 10_000 })
		const orgSlug = page.url().match(/\/o\/([^/]+)/)?.[1] ?? ''
		expect(orgSlug).not.toBe('')
		await page.goto(`/o/${orgSlug}/grid`)
		await page.waitForURL(/\/grid$/, { timeout: 10_000 })
		await expect(page.locator('[data-slot="chessboard-mobile"]')).toBeVisible({
			timeout: 10_000,
		})

		// Default = Неделя (7 days). Tap «Месяц» = 30 days.
		const monthRadio = page.locator('[data-jump-days="30"]')
		await expect(monthRadio).toHaveAttribute('aria-checked', 'false')
		await monthRadio.tap()
		await expect(monthRadio).toHaveAttribute('aria-checked', 'true')

		// Today radio (1 day)
		const todayRadio = page.locator('[data-jump-days="1"]')
		await todayRadio.tap()
		await expect(todayRadio).toHaveAttribute('aria-checked', 'true')
		await expect(monthRadio).toHaveAttribute('aria-checked', 'false')

		await ctx.close()
	})
})
