/**
 * Strict tests для useCreateBooking retry strategy + delay calc.
 *
 *   [UCB1] retry: network reason → true (until cap)
 *   [UCB2] retry: server (5xx) reason → true (until cap)
 *   [UCB3] retry: validation reason → false (deterministic)
 *   [UCB4] retry: consent_missing → false (deterministic)
 *   [UCB5] retry: stale_availability → false (price changed, retry meaningless)
 *   [UCB6] retry: not_found → false (тенант пропал, retry бесполезен)
 *   [UCB7] retry: rate_limited → false (backend already throttling)
 *   [UCB8] retry: unknown error shape → true (defensive transient)
 *   [UCB9] retry capped at MAX_RETRIES=2 (failureCount >= 2 returns false)
 *   [UCB10] bookingRetryDelay: monotonic exponential до 8000ms cap
 *   [UCB11] bookingRetryDelay: includes jitter (variance 0-250ms)
 */

import { describe, expect, test } from 'vitest'
import { WidgetBookingCommitError } from '../lib/widget-booking-api.ts'
import { bookingRetryDelay, shouldRetryBookingMutation } from './use-create-booking.ts'

describe('shouldRetryBookingMutation', () => {
	test('[UCB1] network reason → true', () => {
		const err = new WidgetBookingCommitError('network', 'fetch failed')
		expect(shouldRetryBookingMutation(0, err)).toBe(true)
	})

	test('[UCB2] server (5xx) reason → true', () => {
		const err = new WidgetBookingCommitError('server', 'HTTP 503', 503)
		expect(shouldRetryBookingMutation(0, err)).toBe(true)
	})

	test('[UCB3] validation → false', () => {
		const err = new WidgetBookingCommitError('validation', 'bad body', 422)
		expect(shouldRetryBookingMutation(0, err)).toBe(false)
	})

	test('[UCB4] consent_missing → false', () => {
		const err = new WidgetBookingCommitError('consent_missing', '152-ФЗ not accepted', 422)
		expect(shouldRetryBookingMutation(0, err)).toBe(false)
	})

	test('[UCB5] stale_availability → false', () => {
		const err = new WidgetBookingCommitError('stale_availability', 'price drift', 409)
		expect(shouldRetryBookingMutation(0, err)).toBe(false)
	})

	test('[UCB6] not_found → false', () => {
		const err = new WidgetBookingCommitError('not_found', 'tenant gone', 404)
		expect(shouldRetryBookingMutation(0, err)).toBe(false)
	})

	test('[UCB7] rate_limited → false', () => {
		const err = new WidgetBookingCommitError('rate_limited', 'too many', 429, 60)
		expect(shouldRetryBookingMutation(0, err)).toBe(false)
	})

	test('[UCB8] unknown error shape → true (defensive)', () => {
		expect(shouldRetryBookingMutation(0, new Error('???'))).toBe(true)
		expect(shouldRetryBookingMutation(0, 'string-error')).toBe(true)
	})

	test('[UCB9] capped at 2 retries — failureCount=2 → false', () => {
		const err = new WidgetBookingCommitError('network', 'x')
		expect(shouldRetryBookingMutation(0, err)).toBe(true)
		expect(shouldRetryBookingMutation(1, err)).toBe(true)
		expect(shouldRetryBookingMutation(2, err)).toBe(false)
		expect(shouldRetryBookingMutation(3, err)).toBe(false)
	})
})

describe('bookingRetryDelay', () => {
	test('[UCB10] monotonic exponential до 8000ms cap', () => {
		// Base values без jitter — extract by repeating draws and taking min
		const baseAt = (attempt: number) => {
			let min = Infinity
			for (let i = 0; i < 50; i++) {
				const d = bookingRetryDelay(attempt) - 0 /* placeholder */
				if (d < min) min = d
			}
			return min
		}
		// Attempt 0: ~1000ms base; with jitter 0-250 → min ≈ 1000
		expect(baseAt(0)).toBeGreaterThanOrEqual(1000)
		expect(baseAt(0)).toBeLessThan(1250)
		// Attempt 1: ~2000ms
		expect(baseAt(1)).toBeGreaterThanOrEqual(2000)
		expect(baseAt(1)).toBeLessThan(2250)
		// Attempt 2: ~4000ms
		expect(baseAt(2)).toBeGreaterThanOrEqual(4000)
		expect(baseAt(2)).toBeLessThan(4250)
		// Attempt 3+: capped at 8000ms (+ jitter)
		expect(baseAt(3)).toBeGreaterThanOrEqual(8000)
		expect(baseAt(3)).toBeLessThan(8250)
		expect(baseAt(10)).toBeGreaterThanOrEqual(8000)
		expect(baseAt(10)).toBeLessThan(8250)
	})

	test('[UCB11] includes jitter — variance across calls', () => {
		const samples = Array.from({ length: 50 }, () => bookingRetryDelay(0))
		const min = Math.min(...samples)
		const max = Math.max(...samples)
		// Pure base would be 1000 every time; jitter adds 0-250 → spread > 50ms
		expect(max - min).toBeGreaterThan(50)
		expect(max).toBeLessThan(1250)
	})
})
