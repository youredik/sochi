import { describe, expect, test } from 'vitest'
import { cancelFeeLineId, feeMicrosToMinor, noShowFeeLineId } from './cancel-fees.ts'

describe('cancelFeeLineId / noShowFeeLineId — deterministic', () => {
	test('cancelFeeLineId stable for same bookingId', () => {
		expect(cancelFeeLineId('book_01ABC')).toBe('cancelFee_book_01ABC')
		expect(cancelFeeLineId('book_01ABC')).toBe(cancelFeeLineId('book_01ABC'))
	})

	test('noShowFeeLineId stable for same bookingId', () => {
		expect(noShowFeeLineId('book_01ABC')).toBe('noShowFee_book_01ABC')
	})

	test('cancel and noShow ids differ for same booking (separate lines)', () => {
		expect(cancelFeeLineId('book_01A')).not.toBe(noShowFeeLineId('book_01A'))
	})

	test('different bookings produce different ids per category', () => {
		expect(cancelFeeLineId('book_01A')).not.toBe(cancelFeeLineId('book_01B'))
		expect(noShowFeeLineId('book_01A')).not.toBe(noShowFeeLineId('book_01B'))
	})
})

describe('feeMicrosToMinor — micros to kopecks', () => {
	test('1000 ₽ = 1_000_000_000 micros → 100_000 minor', () => {
		expect(feeMicrosToMinor(1_000_000_000n)).toBe(100_000n)
	})

	test('0 → 0 (no fee, BAR-flex policy)', () => {
		expect(feeMicrosToMinor(0n)).toBe(0n)
	})

	test('negative defensive → 0 (corrupted snapshot, no charge)', () => {
		expect(feeMicrosToMinor(-1_000n)).toBe(0n)
	})

	test('truncation: 5_000_555 micros → 500 minor (round toward zero)', () => {
		// 5_000_555 / 10_000 = 500.0555 → bigint trunc = 500.
		expect(feeMicrosToMinor(5_000_555n)).toBe(500n)
	})

	test('large value preserves precision (no overflow)', () => {
		// 1 млрд ₽ = 10^15 micros. ÷ 10^4 = 10^11 minor = 100 млрд kopecks.
		expect(feeMicrosToMinor(1_000_000_000_000_000n)).toBe(100_000_000_000n)
	})
})
