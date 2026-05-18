/**
 * TimeProvider — strict unit tests (Stripe Test Clocks canon).
 *
 * Pre-done audit (each invariant tested via exact-value assertion):
 *   [R1] realTimeProvider.now() returns fresh Date instance each call
 *   [R2] realTimeProvider.now() returns value within 1s of system clock
 *   [F1] frozenTimeProvider(Date) returns pinned instant
 *   [F2] frozenTimeProvider(ISO string) parses correctly
 *   [F3] frozenTimeProvider returns NEW Date instance each call (mutability isolation)
 *   [F4] advance(ms) shifts now() by exact ms (positive)
 *   [F5] advance(-ms) rewinds clock
 *   [F6] setNow(date) re-pins clock к new instant
 *   [F7] setNow(ISO string) parses correctly
 *   [F8] adversarial: invalid Date input throws
 *   [F9] adversarial: invalid ISO string в constructor throws
 *   [F10] adversarial: invalid ISO string в setNow throws
 *   [F11] mutating returned now() Date does NOT shift the clock
 *   [F12] frozenTimeProvider clones input Date (independent of caller mutation)
 */

import { describe, expect, it } from 'bun:test'
import { frozenTimeProvider, realTimeProvider } from './time-provider.ts'

describe('realTimeProvider', () => {
	it('[R1] each call returns fresh Date instance', () => {
		const a = realTimeProvider.now()
		const b = realTimeProvider.now()
		expect(a).not.toBe(b) // different references
	})

	it('[R2] now() returns value within 1s of system clock', () => {
		const before = Date.now()
		const got = realTimeProvider.now()
		const after = Date.now()
		const gotMs = got.getTime()
		expect(gotMs).toBeGreaterThanOrEqual(before)
		expect(gotMs).toBeLessThanOrEqual(after)
	})
})

describe('frozenTimeProvider — pinning', () => {
	it('[F1] returns pinned instant from Date input', () => {
		const at = new Date('2026-05-18T12:00:00Z')
		const clock = frozenTimeProvider(at)
		expect(clock.now().toISOString()).toBe('2026-05-18T12:00:00.000Z')
	})

	it('[F2] parses ISO string input', () => {
		const clock = frozenTimeProvider('2026-01-01T00:00:00Z')
		expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z')
	})

	it('[F3] each now() call returns fresh Date instance', () => {
		const clock = frozenTimeProvider('2026-05-18T00:00:00Z')
		const a = clock.now()
		const b = clock.now()
		expect(a).not.toBe(b)
		expect(a.getTime()).toBe(b.getTime())
	})
})

describe('frozenTimeProvider — advance', () => {
	it('[F4] advance(+ms) shifts now() forward by exact ms', () => {
		const clock = frozenTimeProvider('2026-05-18T00:00:00Z')
		clock.advance(60 * 60 * 1000) // +1 hour
		expect(clock.now().toISOString()).toBe('2026-05-18T01:00:00.000Z')
	})

	it('[F5] advance(-ms) rewinds clock', () => {
		const clock = frozenTimeProvider('2026-05-18T12:00:00Z')
		clock.advance(-60 * 60 * 1000) // -1 hour
		expect(clock.now().toISOString()).toBe('2026-05-18T11:00:00.000Z')
	})
})

describe('frozenTimeProvider — setNow', () => {
	it('[F6] setNow(Date) re-pins clock', () => {
		const clock = frozenTimeProvider('2026-01-01T00:00:00Z')
		clock.setNow(new Date('2027-06-15T08:30:00Z'))
		expect(clock.now().toISOString()).toBe('2027-06-15T08:30:00.000Z')
	})

	it('[F7] setNow(ISO string) parses correctly', () => {
		const clock = frozenTimeProvider('2026-01-01T00:00:00Z')
		clock.setNow('2027-06-15T08:30:00Z')
		expect(clock.now().toISOString()).toBe('2027-06-15T08:30:00.000Z')
	})
})

describe('frozenTimeProvider — adversarial', () => {
	it('[F8] invalid Date input throws', () => {
		expect(() => frozenTimeProvider(new Date('not-a-date'))).toThrow(/invalid date input/)
	})

	it('[F9] invalid ISO string в constructor throws', () => {
		expect(() => frozenTimeProvider('not-an-iso-string')).toThrow(/invalid date input/)
	})

	it('[F10] invalid ISO string в setNow throws', () => {
		const clock = frozenTimeProvider('2026-01-01T00:00:00Z')
		expect(() => clock.setNow('garbage')).toThrow(/invalid date input/)
	})

	it('[F11] mutating returned Date does NOT shift the clock', () => {
		const clock = frozenTimeProvider('2026-05-18T00:00:00Z')
		const got = clock.now()
		got.setUTCFullYear(2099) // mutate
		expect(clock.now().toISOString()).toBe('2026-05-18T00:00:00.000Z') // unchanged
	})

	it('[F12] frozenTimeProvider clones input Date (caller mutation safe)', () => {
		const input = new Date('2026-05-18T00:00:00Z')
		const clock = frozenTimeProvider(input)
		input.setUTCFullYear(2099) // mutate caller's reference
		expect(clock.now().toISOString()).toBe('2026-05-18T00:00:00.000Z') // unchanged
	})
})
