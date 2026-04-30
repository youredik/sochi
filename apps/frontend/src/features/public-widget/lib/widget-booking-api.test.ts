/**
 * Strict tests для widget-booking-api fetch helper.
 *
 *   [WBA1] Idempotency-Key uniqueness — every call returns fresh UUID v4
 *   [WBA2] generateIdempotencyKey fallback (when crypto.randomUUID absent)
 *   [WBA3] commitBooking happy path — 200 returns parsed body.data
 *   [WBA4] 404 → not_found reason
 *   [WBA5] 409 → stale_availability reason (status code path)
 *   [WBA6] 422 + WIDGET_CONSENT_MISSING → consent_missing reason (code-driven)
 *   [WBA7] 422 generic → validation reason
 *   [WBA8] 400 → validation reason
 *   [WBA9] 429 → rate_limited + retryAfterSeconds parsed from header
 *   [WBA10] 500 → server reason
 *   [WBA11] fetch throws → network reason (preserves message)
 *   [WBA12] Includes Idempotency-Key header в request
 *   [WBA13] STALE_AVAILABILITY code path even с не-409 status (defensive)
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
	commitBooking,
	generateIdempotencyKey,
	WidgetBookingCommitError,
} from './widget-booking-api.ts'

describe('generateIdempotencyKey', () => {
	test('[WBA1] returns fresh UUID v4 — uniqueness across calls', () => {
		const keys = new Set(Array.from({ length: 50 }, () => generateIdempotencyKey()))
		expect(keys.size).toBe(50)
		// UUID v4 shape
		const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
		for (const k of keys) {
			expect(k).toMatch(uuidV4)
		}
	})

	test('[WBA2] fallback (when crypto.randomUUID absent) → widget-prefixed key', () => {
		const original = (globalThis as { crypto?: Crypto }).crypto
		// Simulate missing API
		Object.defineProperty(globalThis, 'crypto', {
			value: undefined,
			writable: true,
			configurable: true,
		})
		try {
			const key = generateIdempotencyKey()
			expect(key).toMatch(/^widget-\d+-[a-z0-9]+$/)
		} finally {
			Object.defineProperty(globalThis, 'crypto', {
				value: original,
				writable: true,
				configurable: true,
			})
		}
	})
})

describe('commitBooking', () => {
	const minBody = {
		propertyId: 'prop_x',
		checkIn: '2026-06-01',
		checkOut: '2026-06-03',
		adults: 2,
		children: 0,
		roomTypeId: 'rt_x',
		ratePlanId: 'rp_x',
		expectedTotalKopecks: 1000_000,
		addons: [],
		guest: {
			firstName: 'Иван',
			lastName: 'Иванов',
			email: 'i@example.com',
			phone: '+79651234567',
			citizenship: 'RU',
		},
		consents: { acceptedDpa: true, acceptedMarketing: false },
		consentSnapshot: {
			dpaText: 'dpa text',
			marketingText: 'mk text',
			version: 'v1.0',
		},
		paymentMethod: 'card' as const,
	}

	let fetchSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, 'fetch')
	})
	afterEach(() => {
		fetchSpy.mockRestore()
	})

	test('[WBA3] happy path — 200 returns parsed body.data', async () => {
		const expected = {
			bookingId: 'book_1',
			guestId: 'gst_1',
			paymentId: 'pay_1',
			paymentStatus: 'succeeded',
			confirmationToken: null,
			totalKopecks: 1000_000,
		}
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ data: expected }), { status: 200 }),
		)
		const result = await commitBooking('acme-hotel', minBody, 'idem-1')
		expect(result).toEqual(expected)
	})

	test('[WBA4] 404 → not_found reason', async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no slug' } }), {
				status: 404,
			}),
		)
		await expect(commitBooking('acme', minBody, 'idem')).rejects.toMatchObject({
			reason: 'not_found',
			status: 404,
		})
	})

	test('[WBA5] 409 → stale_availability reason', async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: { code: 'STALE', message: 'price drift' } }), {
				status: 409,
			}),
		)
		await expect(commitBooking('acme', minBody, 'idem')).rejects.toMatchObject({
			reason: 'stale_availability',
			status: 409,
		})
	})

	test('[WBA6] 422 + WIDGET_CONSENT_MISSING → consent_missing reason', async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					error: { code: 'WIDGET_CONSENT_MISSING', message: '152-ФЗ not accepted' },
				}),
				{ status: 422 },
			),
		)
		await expect(commitBooking('acme', minBody, 'idem')).rejects.toMatchObject({
			reason: 'consent_missing',
			status: 422,
		})
	})

	test('[WBA7] 422 generic → validation reason', async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR' } }), { status: 422 }),
		)
		await expect(commitBooking('acme', minBody, 'idem')).rejects.toMatchObject({
			reason: 'validation',
			status: 422,
		})
	})

	test('[WBA8] 400 → validation reason', async () => {
		fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: {} }), { status: 400 }))
		await expect(commitBooking('acme', minBody, 'idem')).rejects.toMatchObject({
			reason: 'validation',
			status: 400,
		})
	})

	test('[WBA9] 429 → rate_limited + retryAfterSeconds parsed', async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: { code: 'RATE_LIMITED' } }), {
				status: 429,
				headers: { 'Retry-After': '60' },
			}),
		)
		const err = await commitBooking('acme', minBody, 'idem').catch((e) => e)
		expect(err).toBeInstanceOf(WidgetBookingCommitError)
		expect(err.reason).toBe('rate_limited')
		expect(err.retryAfterSeconds).toBe(60)
	})

	test('[WBA10] 500 → server reason', async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }), { status: 500 }),
		)
		await expect(commitBooking('acme', minBody, 'idem')).rejects.toMatchObject({
			reason: 'server',
			status: 500,
		})
	})

	test('[WBA11] fetch throws → network reason (preserves message)', async () => {
		fetchSpy.mockRejectedValueOnce(new Error('connection reset'))
		const err = await commitBooking('acme', minBody, 'idem').catch((e) => e)
		expect(err.reason).toBe('network')
		expect(err.message).toContain('connection reset')
	})

	test('[WBA12] sets Idempotency-Key header в request', async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					data: {
						bookingId: 'b',
						guestId: 'g',
						paymentId: 'p',
						paymentStatus: 'succeeded',
						confirmationToken: null,
						totalKopecks: 0,
					},
				}),
				{ status: 200 },
			),
		)
		await commitBooking('acme', minBody, 'fixed-key')
		const callArgs = fetchSpy.mock.calls[0]
		const init = callArgs?.[1] as RequestInit
		const headers = init.headers as Record<string, string>
		expect(headers['Idempotency-Key']).toBe('fixed-key')
		expect(headers['Content-Type']).toBe('application/json')
	})

	test('[WBA13] STALE_AVAILABILITY code path even при не-409 status (defensive)', async () => {
		// Defensive: backend may return 422 with STALE code; client maps either path
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: { code: 'STALE_AVAILABILITY' } }), { status: 422 }),
		)
		await expect(commitBooking('acme', minBody, 'idem')).rejects.toMatchObject({
			reason: 'stale_availability',
		})
	})
})
