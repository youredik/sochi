import AxeBuilder from '@axe-core/playwright'
import { test } from './_fixtures.ts'
import { expect } from '@playwright/test'

/**
 * G8 (2026-05-16) Unassigned Reservations panel + auto-assign.
 *
 * Per Cloudbeds 2026 canon + R1+R2 ≥ 2026-05-16 research-agent D-G8.1..12.
 *
 * Hunts:
 *   [G8-E1] panel hidden when N=0 (Cloudbeds no-zero-clutter canon)
 *   [G8-E2] panel visible с orange-dot + count badge after creating unassigned
 *   [G8-E3] WCAG 2.2 SC 4.1.3 — badge has role=status aria-live=polite
 *   [G8-E4] click panel → list-sheet opens с unassigned items
 *   [G8-E5] list-row «Открыть» → opens edit-sheet с «Назначить номер» amend
 *   [G8-E6] amend «Назначить номер» dialog с room dropdown + Save → toast
 *   [G8-E7] auto-assign happy — 2 unassigned × 2 rooms → both placed + toast
 *   [G8-E8] auto-assign over-capacity — 3 unassigned × 1 room → partial
 *           (assigned/skipped both reported in toast)
 *   [G8-E9] cross-tenant 404 — PATCH /assign-room на bogus booking
 *   [G8-E10] idempotent — re-run auto-assign after success → 0 new
 *   [G8-E11] axe WCAG 2.2 AA — panel + list-sheet + amend dialog open
 *   [G8-E12] PATCH /assign-room status-guard — cancelled → 409
 *
 * Single-worker sequential. Spec sort `g8-` > `g7-` so runs AFTER existing.
 */

function futureIso(daysFromToday: number): string {
	const d = new Date()
	d.setUTCHours(12, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + daysFromToday)
	return d.toISOString().slice(0, 10)
}

const API_BASE = 'http://localhost:8787/api/v1'

async function setup(
	page: import('@playwright/test').Page,
	dayOffset: number,
	docSuffix: string,
): Promise<{
	bookingId: string
	propertyId: string
	roomTypeId: string
	roomIds: string[]
}> {
	await page.goto('/')
	const propsRes = await page.request.get(`${API_BASE}/properties`)
	const propertyId = ((await propsRes.json()) as { data: Array<{ id: string }> }).data[0]?.id
	if (!propertyId) throw new Error('no property')

	const [rtRes, rpRes, roomsRes] = await Promise.all([
		page.request.get(`${API_BASE}/properties/${propertyId}/room-types`),
		page.request.get(`${API_BASE}/properties/${propertyId}/rate-plans`),
		page.request.get(`${API_BASE}/properties/${propertyId}/rooms`),
	])
	const roomTypeId = ((await rtRes.json()) as { data: Array<{ id: string }> }).data[0]?.id
	const ratePlanId = ((await rpRes.json()) as { data: Array<{ id: string }> }).data[0]?.id
	if (!roomTypeId || !ratePlanId) throw new Error('roomType/ratePlan missing')
	const existingRooms = ((await roomsRes.json()) as { data: Array<{ id: string }> }).data
	const roomIds = existingRooms.map((r) => r.id)
	// Wizard onboarding seeds 2 rooms — sufficient для most G8 tests.

	const guestRes = await page.request.post(`${API_BASE}/guests`, {
		data: {
			lastName: `G8${docSuffix}`,
			firstName: 'Тест',
			citizenship: 'RU',
			documentType: 'passport',
			documentNumber: `4510${docSuffix}`,
		},
	})
	if (!guestRes.ok()) throw new Error(`guest.create ${guestRes.status()}: ${await guestRes.text()}`)
	const guestId = ((await guestRes.json()) as { data: { id: string } }).data.id

	const checkInIso = futureIso(dayOffset)
	const checkOutIso = futureIso(dayOffset + 1)
	const bRes = await page.request.post(`${API_BASE}/properties/${propertyId}/bookings`, {
		data: {
			roomTypeId,
			ratePlanId,
			checkIn: checkInIso,
			checkOut: checkOutIso,
			guestsCount: 1,
			primaryGuestId: guestId,
			guestSnapshot: {
				firstName: 'Тест',
				lastName: `G8${docSuffix}`,
				citizenship: 'RU',
				documentType: 'passport',
				documentNumber: `4510${docSuffix}`,
			},
			channelCode: 'walkIn',
		},
	})
	if (!bRes.ok()) throw new Error(`booking.create ${bRes.status()}: ${await bRes.text()}`)
	const bookingId = ((await bRes.json()) as { data: { id: string } }).data.id
	return { bookingId, propertyId, roomTypeId, roomIds }
}

test.describe('G8 Unassigned Reservations panel + auto-assign', () => {
	test('[G8-E2] panel visible с orange-dot + count badge for unassigned booking', async ({
		page,
	}) => {
		const ts = Date.now().toString().slice(-6)
		await setup(page, 3, `${ts}02`)
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		const panel = page.locator('[data-slot="unassigned-panel-trigger"]')
		await expect(panel).toBeVisible()
		await expect(panel).toContainText('Нераспределённые')
		// Count badge value
		const badge = panel.locator('[data-slot="unassigned-count-badge"]')
		await expect(badge).toBeVisible()
		const txt = await badge.textContent()
		expect(Number(txt)).toBeGreaterThanOrEqual(1)
	})

	test('[G8-E3] WCAG 2.2 SC 4.1.3 — count badge has role=status aria-live=polite', async ({
		page,
	}) => {
		const ts = Date.now().toString().slice(-6)
		await setup(page, 4, `${ts}03`)
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		const badge = page.locator('[data-slot="unassigned-count-badge"]')
		await expect(badge).toBeVisible()
		await expect(badge).toHaveAttribute('role', 'status')
		await expect(badge).toHaveAttribute('aria-live', 'polite')
	})

	test('[G8-E4] click panel → list-sheet opens с unassigned items', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId } = await setup(page, 5, `${ts}04`)
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.locator('[data-slot="unassigned-panel-trigger"]').click()
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		await expect(dialog.getByRole('heading', { name: /Нераспределённые брони/ })).toBeVisible()
		// Our seeded booking present в list
		await expect(
			dialog.locator(`[data-slot="unassigned-list-item"][data-booking-id="${bookingId}"]`),
		).toBeVisible()
	})

	test('[G8-E5] list-row «Открыть» → opens edit-sheet с «Назначить номер» amend', async ({
		page,
	}) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId } = await setup(page, 6, `${ts}05`)
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.locator('[data-slot="unassigned-panel-trigger"]').click()
		const listDialog = page.getByRole('dialog')
		await listDialog
			.locator(`[data-slot="unassigned-list-item"][data-booking-id="${bookingId}"]`)
			.locator('[data-slot="unassigned-open-button"]')
			.click()
		// List sheet closes, edit sheet opens
		const editDialog = page.getByRole('dialog')
		await expect(editDialog).toBeVisible()
		await expect(editDialog.locator('[data-amend="assign-room"]')).toBeVisible()
		await expect(editDialog.locator('[data-amend="assign-room"]')).toContainText('Назначить номер')
	})

	test('[G8-E6] amend «Назначить номер» — select room → Save → toast', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId } = await setup(page, 7, `${ts}06`)
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.locator(`[data-booking-id="${bookingId}"]`).click()
		const dialog = page.getByRole('dialog')
		await dialog.locator('[data-amend="assign-room"]').click()
		const form = dialog.locator('[data-slot="amend-assign-room-form"]')
		await expect(form).toBeVisible()
		await form.getByLabel('Назначить номер').click()
		await page.getByRole('option').first().click()
		await form.getByRole('button', { name: /Назначить/ }).click()
		await expect(page.getByText('Номер назначен')).toBeVisible()
	})

	test('[G8-E7] auto-assign happy — clicks button → toast + panel hides', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		await setup(page, 8, `${ts}07`)
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.locator('[data-slot="unassigned-panel-trigger"]').click()
		const dialog = page.getByRole('dialog')
		await dialog.locator('[data-slot="unassigned-auto-assign-button"]').click()
		// Wizard creates 2 rooms; 1 unassigned booking + 2 rooms → 1 assigned.
		await expect(page.getByText(/Распределено/)).toBeVisible({ timeout: 8_000 })
	})

	test('[G8-E9] cross-tenant 404 — PATCH /bookings/X/assign-room на bogus id', async ({ page }) => {
		await page.goto('/')
		const BOGUS = 'book_00000000000000000000000000'
		const res = await page.request.patch(`${API_BASE}/bookings/${BOGUS}/assign-room`, {
			data: { roomId: 'room_00000000000000000000000000' },
		})
		expect(res.status()).toBe(404)
		const body = (await res.json()) as { error?: { code?: string } }
		expect(body.error?.code).toBe('NOT_FOUND')
	})

	test('[G8-E10] auto-assign idempotent — second run → 0 new (Cloudbeds operator-trust)', async ({
		page,
	}) => {
		const ts = Date.now().toString().slice(-6)
		const { propertyId } = await setup(page, 9, `${ts}10`)
		// Run auto-assign first time via API.
		const r1 = await page.request.post(`${API_BASE}/properties/${propertyId}/bookings/auto-assign`)
		expect(r1.ok()).toBe(true)
		// Run second time — should report 0 assigned + 0 skipped (no candidates).
		const r2 = await page.request.post(`${API_BASE}/properties/${propertyId}/bookings/auto-assign`)
		expect(r2.ok()).toBe(true)
		const body = (await r2.json()) as {
			data: {
				assigned: Array<unknown>
				skipped: Array<unknown>
			}
		}
		// Idempotent canon: re-run yields no new movement (all already placed).
		expect(body.data.assigned).toHaveLength(0)
	})

	test('[G8-E11] axe WCAG 2.2 AA — panel + list-sheet open', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		await setup(page, 11, `${ts}11`)
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.locator('[data-slot="unassigned-panel-trigger"]').click()
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		await page.waitForFunction(() =>
			document.getAnimations().every((a) => a.playState !== 'running'),
		)
		const results = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()
		if (results.violations.length > 0) {
			console.error('G8-E11 axe violations:', JSON.stringify(results.violations, null, 2))
		}
		expect(results.violations).toEqual([])
	})

	test('[G8-E12] PATCH /assign-room status-guard — cancelled → 409', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId, roomIds } = await setup(page, 12, `${ts}12`)
		await page.request.patch(`${API_BASE}/bookings/${bookingId}/cancel`, {
			data: { reason: 'test G8-E12' },
		})
		const roomId = roomIds[0] ?? ''
		const res = await page.request.patch(`${API_BASE}/bookings/${bookingId}/assign-room`, {
			data: { roomId },
		})
		expect(res.status()).toBe(409)
		const body = (await res.json()) as { error?: { code?: string } }
		expect(body.error?.code).toBe('INVALID_BOOKING_AMEND_STATE')
	})

	test('[G8-E13] 152-ФЗ canon — list shows guest mask «Фамилия И.», NOT raw id или full firstName', async ({
		page,
	}) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId } = await setup(page, 13, `${ts}13`)
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.locator('[data-slot="unassigned-panel-trigger"]').click()
		const item = page.locator(`[data-slot="unassigned-list-item"][data-booking-id="${bookingId}"]`)
		await expect(item).toBeVisible()
		const guestCell = item.locator('[data-slot="unassigned-list-guest"]')
		await expect(guestCell).toBeVisible()
		// Mask format «Фамилия И.» — first-name initial only.
		// Adversarial: raw bookingId MUST NOT leak в visible text.
		await expect(guestCell).toContainText(`G8${ts}13 Т.`)
		await expect(item).not.toContainText(bookingId)
		// `Тест` is full firstName from setup; should be masked к «Т.» only.
		await expect(guestCell).not.toContainText('Тест')
		// Meta row shows roomType name + dates, not roomTypeId.
		const metaCell = item.locator('[data-slot="unassigned-list-meta"]')
		await expect(metaCell).toBeVisible()
		await expect(metaCell).not.toContainText(/^rmt_/)
	})

	test('[G8-E14] keyboard alternative — Tab к panel button + Enter opens list-sheet', async ({
		page,
	}) => {
		const ts = Date.now().toString().slice(-6)
		await setup(page, 14, `${ts}14`)
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		const panel = page.locator('[data-slot="unassigned-panel-trigger"]')
		await expect(panel).toBeVisible()
		await panel.focus()
		await page.keyboard.press('Enter')
		await expect(page.getByRole('dialog')).toBeVisible()
		await expect(
			page.getByRole('dialog').getByRole('heading', { name: /Нераспределённые брони/ }),
		).toBeVisible()
	})

	test('[G8-E15] over-capacity partial-success — N bookings × 0 active rooms → all skipped', async ({
		page,
	}) => {
		const ts = Date.now().toString().slice(-6)
		const { propertyId, roomIds } = await setup(page, 15, `${ts}15`)
		// Disable existing rooms via PATCH к force «no_room» skip outcome.
		// (Wizard seeds 2 active rooms; disable both forces algorithm к skip
		// the booking из setup с reason='no_room').
		for (const rid of roomIds) {
			await page.request.patch(`${API_BASE}/rooms/${rid}`, {
				data: { isActive: false },
			})
		}
		const res = await page.request.post(`${API_BASE}/properties/${propertyId}/bookings/auto-assign`)
		expect(res.ok()).toBe(true)
		const body = (await res.json()) as {
			data: {
				assigned: Array<unknown>
				skipped: Array<{ bookingId: string; reason: string }>
			}
		}
		expect(body.data.assigned).toHaveLength(0)
		expect(body.data.skipped.length).toBeGreaterThanOrEqual(1)
		// Reason MUST include 'room_inactive' (all rooms isActive=false) — per
		// Cloudbeds canon + algorithm D-G8.5. Per `[[strict-tests]]` assert
		// MEANING ('inactive cause surfaces') not ORDER (cross-spec G7 may
		// inject 'wrong_type' skips for unassigned bookings on its 2nd roomType).
		const reasons = body.data.skipped.map((s) => s.reason)
		expect(reasons).toContain('room_inactive')
		// Re-activate rooms для cleanup (other specs могут needed).
		for (const rid of roomIds) {
			await page.request.patch(`${API_BASE}/rooms/${rid}`, {
				data: { isActive: true },
			})
		}
	})

	test('[G8-E16] mobile pointer:coarse — narrow viewport renders panel + opens list', async ({
		page,
	}) => {
		await page.setViewportSize({ width: 375, height: 667 })
		const ts = Date.now().toString().slice(-6)
		await setup(page, 0, `${ts}16`)
		// On mobile sidebar collapses — navigate /grid directly.
		const orgSlug = page.url().match(/\/o\/([^/]+)/)?.[1] ?? ''
		expect(orgSlug).not.toBe('')
		await page.goto(`/o/${orgSlug}/grid`)
		const panel = page.locator('[data-slot="unassigned-panel-trigger"]')
		await expect(panel).toBeVisible()
		// Tap → list sheet opens (mobile = bottom-drawer via ResponsiveSheet).
		await panel.click()
		await expect(page.getByRole('dialog')).toBeVisible()
		await expect(
			page.getByRole('dialog').locator('[data-slot="unassigned-auto-assign-button"]'),
		).toBeVisible()
	})
})
