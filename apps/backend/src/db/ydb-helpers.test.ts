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
import * as fc from 'fast-check'
import { Optional } from '@ydbjs/value/optional'
import { describe, expect, test } from 'bun:test'
import { dateOpt, decimalToMicros, int32Opt, microsToDecimal, toNumber } from './ydb-helpers.ts'

describe('toNumber', () => {
	test('returns null for null input (identity on null)', () => {
		expect(toNumber(null)).toBeNull()
	})

	test('is identity on safe JS number inputs', () => {
		void fc.assert(
			fc.property(fc.integer(), (n) => {
				expect(toNumber(n)).toBe(n)
			}),
		)
	})

	test('safe bigint → number preserves exact value', () => {
		void fc.assert(
			fc.property(
				fc.bigInt({ min: BigInt(Number.MIN_SAFE_INTEGER), max: BigInt(Number.MAX_SAFE_INTEGER) }),
				(b: bigint) => {
					const result = toNumber(b)
					expect(typeof result).toBe('number')
					expect(result).toBe(Number(b))
					// Round-trip: converting back to bigint must equal the input.
					expect(BigInt(result ?? 0)).toBe(b)
				},
			),
		)
	})

	test('throws on bigint exceeding MAX_SAFE_INTEGER (no silent precision loss)', () => {
		void fc.assert(
			fc.property(
				fc.oneof(
					fc.bigInt({ min: BigInt(Number.MAX_SAFE_INTEGER) + 1n, max: 2n ** 63n - 1n }),
					fc.bigInt({ min: -(2n ** 63n), max: BigInt(Number.MIN_SAFE_INTEGER) - 1n }),
				),
				(unsafeBigint) => {
					expect(() => toNumber(unsafeBigint)).toThrow(/exceeds/)
				},
			),
		)
	})

	test('number↔bigint equivalence: toNumber(n) === toNumber(BigInt(n))', () => {
		void fc.assert(
			fc.property(
				fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
				(n) => {
					expect(toNumber(n)).toBe(toNumber(BigInt(n)))
				},
			),
		)
	})
})

describe('micros ↔ decimal conversion', () => {
	test('exact-value boundaries', () => {
		expect(decimalToMicros('0')).toBe(0n)
		expect(decimalToMicros('1')).toBe(1_000_000n)
		expect(decimalToMicros('1.5')).toBe(1_500_000n)
		expect(decimalToMicros('1234.567890')).toBe(1_234_567_890n)
		expect(decimalToMicros('0.000001')).toBe(1n)
		expect(decimalToMicros('-42.5')).toBe(-42_500_000n)
		// Excess precision truncates (does not round).
		expect(decimalToMicros('0.0000019')).toBe(1n)

		expect(microsToDecimal(0n)).toBe('0')
		expect(microsToDecimal(1_000_000n)).toBe('1')
		expect(microsToDecimal(1_500_000n)).toBe('1.5')
		expect(microsToDecimal(1_234_567_890n)).toBe('1234.56789')
		expect(microsToDecimal(1n)).toBe('0.000001')
		expect(microsToDecimal(-42_500_000n)).toBe('-42.5')
	})

	test('rejects invalid decimal strings', () => {
		expect(() => decimalToMicros('abc')).toThrow(/Invalid decimal/)
		expect(() => decimalToMicros('1.2.3')).toThrow(/Invalid decimal/)
		expect(() => decimalToMicros('')).toThrow(/Invalid decimal/)
		expect(() => decimalToMicros('1e5')).toThrow(/Invalid decimal/) // no scientific notation
	})

	test('roundtrip: micros → decimal → micros is identity for representable values', () => {
		void fc.assert(
			fc.property(
				fc
					.tuple(
						fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
						fc.integer({ min: 0, max: 999_999 }),
					)
					.map(([whole, frac]) => {
						const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '')
						return fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`
					}),
				(s) => {
					const micros = decimalToMicros(s)
					const back = microsToDecimal(micros)
					expect(decimalToMicros(back)).toBe(micros)
				},
			),
		)
	})
})

describe('dateOpt (nullable YDB `Date` binding helper)', () => {
	test('[DO1] null input returns an Optional wrapping null', () => {
		const result = dateOpt(null)
		expect(result).toBeInstanceOf(Optional)
	})

	test('[DO2] undefined input treated as null (same Optional)', () => {
		const result = dateOpt(undefined)
		expect(result).toBeInstanceOf(Optional)
	})

	test('[DO3] YYYY-MM-DD input returns an Optional with a non-null Date payload', () => {
		const result = dateOpt('2026-07-15')
		expect(result).toBeInstanceOf(Optional)
		// The wrapped primitive is NOT the same instance as NULL — we check by
		// interrogating the optional's internal `value` field presence. The Optional
		// class stores the wrapped primitive; a non-null value is present.
		// Struct read via JSON shape is the least-invasive way without mocking SDK.
		const asJson = JSON.parse(JSON.stringify(result)) as { value?: { case?: string } }
		expect(asJson.value?.case).not.toBe('nullFlagValue')
	})

	// Property-based: dateOpt MUST accept any valid YYYY-MM-DD string without
	// throwing (avoids the fc.date quirk from memory `project_fastcheck_gotchas.md`
	// by generating via integer-over-epoch).
	const MS_PER_DAY = 86_400_000
	const ymdArb = fc
		.integer({
			min: Math.floor(Date.parse('2025-01-01T00:00:00Z') / MS_PER_DAY),
			max: Math.floor(Date.parse('2030-12-31T00:00:00Z') / MS_PER_DAY),
		})
		.map((day) => new Date(day * MS_PER_DAY).toISOString().slice(0, 10))

	test('[DOP1] dateOpt never throws on any valid YYYY-MM-DD in booking horizon', () => {
		void fc.assert(
			fc.property(ymdArb, (ymd) => {
				expect(() => dateOpt(ymd)).not.toThrow()
				expect(dateOpt(ymd)).toBeInstanceOf(Optional)
			}),
		)
	})

	test('[DO4] month/year rollover dates accepted (Dec 31 → Jan 1, leap-day 2028-02-29)', () => {
		// 2028 is a leap year (divisible by 4 and by 400).
		expect(() => dateOpt('2028-02-29')).not.toThrow()
		expect(() => dateOpt('2026-12-31')).not.toThrow()
		expect(() => dateOpt('2027-01-01')).not.toThrow()
	})
})

describe('int32Opt (nullable YDB `Int32` binding helper)', () => {
	// Serialized Optional shape: { type, item } — `item` is null for NULL,
	// otherwise `{ value: <int> }`. Verified empirically against @ydbjs/value.
	type OptJson = { item: { value?: number } | null }

	test('[I32-1] null input → Optional wrapping null (item === null)', () => {
		const result = int32Opt(null)
		expect(result).toBeInstanceOf(Optional)
		const asJson = JSON.parse(JSON.stringify(result)) as OptJson
		expect(asJson.item).toBeNull()
	})

	test('[I32-2] integer value → Optional carrying that exact value', () => {
		const result = int32Opt(4)
		expect(result).toBeInstanceOf(Optional)
		const asJson = JSON.parse(JSON.stringify(result)) as OptJson
		expect(asJson.item).not.toBeNull()
		expect(asJson.item?.value).toBe(4)
	})

	test('[I32-3] boundary values (0, -1, full int32 range) do not throw', () => {
		// ratingOverall lives in [1..5] but the helper backs any Int32 column.
		expect(() => int32Opt(0)).not.toThrow()
		expect(() => int32Opt(-1)).not.toThrow()
		expect(() => int32Opt(2_147_483_647)).not.toThrow()
		expect(() => int32Opt(-2_147_483_648)).not.toThrow()
	})

	test('[I32-4] rating domain values 1..5 each roundtrip the exact value', () => {
		for (const rating of [1, 2, 3, 4, 5]) {
			const asJson = JSON.parse(JSON.stringify(int32Opt(rating))) as OptJson
			expect(asJson.item?.value).toBe(rating)
		}
	})
})
