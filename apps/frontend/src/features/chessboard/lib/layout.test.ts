import { describe, expect, it } from 'vitest'
import { bandPosition } from './layout.ts'

/**
 * Strict tests for band positioning — exact column indices, boundary
 * conditions (checkout == window-end, check-in < window-start), and
 * adversarial clip/truncate flags.
 */
describe('bandPosition', () => {
	const FROM = '2026-04-23'
	const TO = '2026-04-29' // 7-day window: cols 0..6

	describe('entirely inside window (exact-value colStart/colEnd)', () => {
		it('1-night booking 23→24 → col [0, 1)', () => {
			expect(bandPosition({ checkIn: '2026-04-23', checkOut: '2026-04-24' }, FROM, TO)).toEqual({
				colStart: 0,
				colEnd: 1,
				truncatedLeft: false,
				truncatedRight: false,
			})
		})
		it('3-night booking 23→26 → cols [0, 3) covering 23/24/25', () => {
			expect(bandPosition({ checkIn: '2026-04-23', checkOut: '2026-04-26' }, FROM, TO)).toEqual({
				colStart: 0,
				colEnd: 3,
				truncatedLeft: false,
				truncatedRight: false,
			})
		})
		it('last-night booking ending at window-end (27→29) → cols [4, 6) covering 27/28', () => {
			expect(bandPosition({ checkIn: '2026-04-27', checkOut: '2026-04-29' }, FROM, TO)).toEqual({
				colStart: 4,
				colEnd: 6,
				truncatedLeft: false,
				truncatedRight: false,
			})
		})
	})

	describe('left-truncated (booking started before window)', () => {
		it('check-in 20 / checkout 25 → clipped to [0, 2) covering 23/24', () => {
			expect(bandPosition({ checkIn: '2026-04-20', checkOut: '2026-04-25' }, FROM, TO)).toEqual({
				colStart: 0,
				colEnd: 2,
				truncatedLeft: true,
				truncatedRight: false,
			})
		})
	})

	describe('right-truncated (booking extends past window)', () => {
		it('check-in 28 / checkout 2026-05-03 → clipped to [5, 7) covering 28/29', () => {
			expect(bandPosition({ checkIn: '2026-04-28', checkOut: '2026-05-03' }, FROM, TO)).toEqual({
				colStart: 5,
				colEnd: 7,
				truncatedLeft: false,
				truncatedRight: true,
			})
		})
	})

	describe('both-truncated (booking envelops window)', () => {
		it('check-in 20 / checkout 2026-05-10 → clipped to full [0, 7)', () => {
			expect(bandPosition({ checkIn: '2026-04-20', checkOut: '2026-05-10' }, FROM, TO)).toEqual({
				colStart: 0,
				colEnd: 7,
				truncatedLeft: true,
				truncatedRight: true,
			})
		})
	})

	describe('entirely outside window → null', () => {
		it('booking before window (15→20) → null', () => {
			expect(bandPosition({ checkIn: '2026-04-15', checkOut: '2026-04-20' }, FROM, TO)).toBeNull()
		})
		it('booking after window (2026-05-01 → 05-05) → null', () => {
			expect(bandPosition({ checkIn: '2026-05-01', checkOut: '2026-05-05' }, FROM, TO)).toBeNull()
		})
		it('booking ending exactly at window-start (20→23, last-night=22) → null', () => {
			// checkout 23 means last night is 22 → before 23 → null
			expect(bandPosition({ checkIn: '2026-04-20', checkOut: '2026-04-23' }, FROM, TO)).toBeNull()
		})
	})

	describe('adversarial (zero-night / reversed)', () => {
		it('same-day check-in/checkout (zero nights) → null', () => {
			expect(bandPosition({ checkIn: '2026-04-23', checkOut: '2026-04-23' }, FROM, TO)).toBeNull()
		})
	})

	describe('boundary: 1-day window (checkout-is-free invariant)', () => {
		it('1-day window [23, 23] with 1-night booking 23→24 → col [0, 1)', () => {
			expect(
				bandPosition({ checkIn: '2026-04-23', checkOut: '2026-04-24' }, '2026-04-23', '2026-04-23'),
			).toEqual({ colStart: 0, colEnd: 1, truncatedLeft: false, truncatedRight: false })
		})
	})
})
