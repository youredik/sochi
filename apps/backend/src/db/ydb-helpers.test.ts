/**
 * Property-based tests for `ydb-helpers.ts`.
 *
 * Why property-based here: `toNumber` normalizes YDB integer columns that
 * deserialize as `number | bigint | null`. With ~20 call sites in repos, any
 * rounding or overflow regression would silently corrupt domain data. Random
 * inputs catch cases hand-rolled tests wouldn't (MAX_SAFE_INTEGER boundaries,
 * negative safe ints, equivalence of number vs bigint representations).
 *
 * Pattern for future domain invariants — copy this shape when writing
 * property-based tests for Rate.compute(), Availability.allotment() etc.
 */
import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { toNumber } from './ydb-helpers.ts'

describe('toNumber', () => {
	test('returns null for null input (identity on null)', () => {
		expect(toNumber(null)).toBeNull()
	})

	test.prop([fc.integer()])('is identity on safe JS number inputs', (n) => {
		expect(toNumber(n)).toBe(n)
	})

	test.prop([
		fc.bigInt({ min: BigInt(Number.MIN_SAFE_INTEGER), max: BigInt(Number.MAX_SAFE_INTEGER) }),
	])('safe bigint → number preserves exact value', (b: bigint) => {
		const result = toNumber(b)
		expect(typeof result).toBe('number')
		expect(result).toBe(Number(b))
		// Round-trip: converting back to bigint must equal the input.
		expect(BigInt(result ?? 0)).toBe(b)
	})

	test.prop([
		fc.oneof(
			fc.bigInt({ min: BigInt(Number.MAX_SAFE_INTEGER) + 1n, max: 2n ** 63n - 1n }),
			fc.bigInt({ min: -(2n ** 63n), max: BigInt(Number.MIN_SAFE_INTEGER) - 1n }),
		),
	])('throws on bigint exceeding MAX_SAFE_INTEGER (no silent precision loss)', (unsafeBigint) => {
		expect(() => toNumber(unsafeBigint)).toThrow(/exceeds/)
	})

	test.prop([fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER })])(
		'number↔bigint equivalence: toNumber(n) === toNumber(BigInt(n))',
		(n) => {
			expect(toNumber(n)).toBe(toNumber(BigInt(n)))
		},
	)
})
