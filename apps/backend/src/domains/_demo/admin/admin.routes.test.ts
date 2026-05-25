/**
 * Round 9 — demo OTA admin control HTTP routes strict tests.
 *
 * Coverage:
 *   [ADM1] POST /reset clears Yandex + Островок state
 *   [ADM2] POST /reset is idempotent (second call also returns 200)
 *   [ADM3] POST /seed returns property descriptor + 3 availability dates
 *   [ADM4] POST /seed dates ISO YYYY-MM-DD shape
 *   [ADM5] POST /trigger with valid scenario → 200 acknowledged
 *   [ADM6] POST /trigger with invalid scenario → 400 invalid_scenario
 *   [ADM7] POST /trigger with malformed JSON → 400 malformed_json
 *   [ADM8] POST /trigger validates all 3 canonical scenarios
 *
 * Strict-tests canon (`feedback_strict_tests`):
 *   - Exact-value `.toBe(...)` / `.toEqual(...)` only
 *   - No weak matchers (см. feedback_strict_tests canon)
 *   - Adversarial cases (malformed body, unknown scenario)
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import {
	__listBookHashes,
	__resetState as __resetOstrovok,
	storeBookHash,
} from '../mock-ota-server/ostrovok/state.ts'
import {
	__listBookingTokens,
	__resetState as __resetYandex,
	storeBookingToken,
} from '../mock-ota-server/yandex/state.ts'
import { createDemoAdminRoutes, TRIGGER_SCENARIOS } from './admin.routes.ts'

function mountApp() {
	const router = createDemoAdminRoutes()
	return new Hono().route('/admin', router)
}

describe('demo OTA admin routes', () => {
	beforeEach(() => {
		__resetYandex()
		__resetOstrovok()
	})
	afterEach(() => {
		__resetYandex()
		__resetOstrovok()
	})

	it('[ADM1] POST /reset clears state в обоих modules', async () => {
		// Seed some state directly via state helpers (bypass HTTP layer).
		storeBookingToken({
			token: 'PRE_RESET_TOK',
			hotelId: 'h1',
			checkinDate: '2027-06-15',
			checkoutDate: '2027-06-17',
			adults: 2,
			children: 0,
			totalPriceMicros: 6_000_000_000n,
		})
		storeBookHash({
			bookHash: 'a'.repeat(32),
			hid: 8473727,
			checkin: '2027-06-15',
			checkout: '2027-06-17',
			adults: 2,
			children: [],
			currency: 'RUB',
			dailyPrices: [7000, 7000],
			totalPrice: 14_000,
			roomName: 'Стандарт',
			mealName: 'Без питания',
		})
		expect(__listBookingTokens().length).toBe(1)
		expect(__listBookHashes().length).toBe(1)

		const app = mountApp()
		const res = await app.request('/admin/reset', { method: 'POST' })
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			ok: boolean
			cleared: { yandex: boolean; ostrovok: boolean }
		}
		expect(body.ok).toBe(true)
		expect(body.cleared.yandex).toBe(true)
		expect(body.cleared.ostrovok).toBe(true)

		// Verify state actually empty after reset.
		expect(__listBookingTokens().length).toBe(0)
		expect(__listBookHashes().length).toBe(0)
	})

	it('[ADM2] POST /reset is idempotent (second call also returns 200)', async () => {
		const app = mountApp()
		const first = await app.request('/admin/reset', { method: 'POST' })
		const second = await app.request('/admin/reset', { method: 'POST' })
		expect(first.status).toBe(200)
		expect(second.status).toBe(200)
		const secondBody = (await second.json()) as { ok: boolean }
		expect(secondBody.ok).toBe(true)
	})

	it('[ADM3] POST /seed returns property descriptor + 3 availability dates', async () => {
		const app = mountApp()
		const res = await app.request('/admin/seed', { method: 'POST' })
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			ok: boolean
			seeded: {
				property: { id: string; name: string }
				availabilityDates: ReadonlyArray<string>
				channels: ReadonlyArray<string>
			}
		}
		expect(body.ok).toBe(true)
		expect(body.seeded.property.id).toBe('demo-hotel-sochi')
		expect(body.seeded.property.name).toBe('Sochi Demo Hotel')
		expect(body.seeded.availabilityDates.length).toBe(3)
		expect(body.seeded.channels).toEqual(['yandex', 'ostrovok'])
	})

	it('[ADM4] POST /seed dates are ISO YYYY-MM-DD shape', async () => {
		const app = mountApp()
		const res = await app.request('/admin/seed', { method: 'POST' })
		const body = (await res.json()) as {
			seeded: { availabilityDates: ReadonlyArray<string> }
		}
		for (const date of body.seeded.availabilityDates) {
			expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		}
	})

	it('[ADM5] POST /trigger with valid scenario returns 200 acknowledged', async () => {
		const app = mountApp()
		const res = await app.request('/admin/trigger', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ scenario: 'overbooking' }),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			ok: boolean
			scenario: string
			status: string
		}
		expect(body.ok).toBe(true)
		expect(body.scenario).toBe('overbooking')
		expect(body.status).toBe('acknowledged')
	})

	it('[ADM6] POST /trigger with invalid scenario returns 400 invalid_scenario', async () => {
		const app = mountApp()
		const res = await app.request('/admin/trigger', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ scenario: 'nuclear-meltdown' }),
		})
		expect(res.status).toBe(400)
		const body = (await res.json()) as {
			error: string
			validScenarios: ReadonlyArray<string>
		}
		expect(body.error).toBe('invalid_scenario')
		expect(body.validScenarios).toEqual(['overbooking', 'cancel-late', 'payment-fail'])
	})

	it('[ADM7] POST /trigger with malformed JSON returns 400 malformed_json', async () => {
		const app = mountApp()
		const res = await app.request('/admin/trigger', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{not valid json',
		})
		expect(res.status).toBe(400)
		const body = (await res.json()) as { error: string }
		expect(body.error).toBe('malformed_json')
	})

	it('[ADM8] POST /trigger validates all 3 canonical scenarios', async () => {
		const app = mountApp()
		for (const scenario of TRIGGER_SCENARIOS) {
			const res = await app.request('/admin/trigger', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ scenario }),
			})
			expect(res.status).toBe(200)
			const body = (await res.json()) as { scenario: string }
			expect(body.scenario).toBe(scenario)
		}
	})

	it('[ADM9] POST /trigger missing scenario field returns 400 invalid_scenario', async () => {
		const app = mountApp()
		const res = await app.request('/admin/trigger', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({}),
		})
		expect(res.status).toBe(400)
		const body = (await res.json()) as { error: string }
		expect(body.error).toBe('invalid_scenario')
	})

	it('[ADM10] POST /seed accepts seedDateCount override via factory', async () => {
		const router = createDemoAdminRoutes({ seedDateCount: 5 })
		const app = new Hono().route('/admin', router)
		const res = await app.request('/admin/seed', { method: 'POST' })
		const body = (await res.json()) as {
			seeded: { availabilityDates: ReadonlyArray<string> }
		}
		expect(body.seeded.availabilityDates.length).toBe(5)
	})

	// ── Round 11 P1-B2 — admin session token gate ─────────────────────────
	describe('Round 11 P1-B2 — session token gating', () => {
		it('[ADM11] sessionToken empty → unauthenticated request passes (test mode)', async () => {
			const router = createDemoAdminRoutes() // no token
			const app = new Hono().route('/admin', router)
			const res = await app.request('/admin/reset', { method: 'POST' })
			expect(res.status).toBe(200)
		})

		it('[ADM12] sessionToken set + missing header → 401', async () => {
			const router = createDemoAdminRoutes({ sessionToken: 'demo_admin_abc123' })
			const app = new Hono().route('/admin', router)
			const res = await app.request('/admin/reset', { method: 'POST' })
			expect(res.status).toBe(401)
			const body = (await res.json()) as { error: string }
			expect(body.error).toBe('UNAUTHORIZED')
		})

		it('[ADM13] sessionToken set + wrong header → 401', async () => {
			const router = createDemoAdminRoutes({ sessionToken: 'demo_admin_abc123' })
			const app = new Hono().route('/admin', router)
			const res = await app.request('/admin/reset', {
				method: 'POST',
				headers: { 'x-demo-session-token': 'wrong_token' },
			})
			expect(res.status).toBe(401)
		})

		it('[ADM14] sessionToken set + correct header → 200', async () => {
			const router = createDemoAdminRoutes({ sessionToken: 'demo_admin_abc123' })
			const app = new Hono().route('/admin', router)
			const res = await app.request('/admin/reset', {
				method: 'POST',
				headers: { 'x-demo-session-token': 'demo_admin_abc123' },
			})
			expect(res.status).toBe(200)
			const body = (await res.json()) as { ok: boolean }
			expect(body.ok).toBe(true)
		})
	})
})
