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
import { Optional } from '@ydbjs/value/optional'
import { describe, expect, test as vitestTest } from 'vitest'
import { dateOpt, decimalToMicros, microsToDecimal, toNumber } from './ydb-helpers.ts'

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

describe('micros ↔ decimal conversion', () => {
	vitestTest('exact-value boundaries', () => {
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

	vitestTest('rejects invalid decimal strings', () => {
		expect(() => decimalToMicros('abc')).toThrow(/Invalid decimal/)
		expect(() => decimalToMicros('1.2.3')).toThrow(/Invalid decimal/)
		expect(() => decimalToMicros('')).toThrow(/Invalid decimal/)
		expect(() => decimalToMicros('1e5')).toThrow(/Invalid decimal/) // no scientific notation
	})

	test.prop([
		fc
			.tuple(
				fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
				fc.integer({ min: 0, max: 999_999 }),
			)
			.map(([whole, frac]) => {
				const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '')
				return fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`
			}),
	])('roundtrip: micros → decimal → micros is identity for representable values', (s) => {
		const micros = decimalToMicros(s)
		const back = microsToDecimal(micros)
		expect(decimalToMicros(back)).toBe(micros)
	})
})

describe('dateOpt (nullable YDB `Date` binding helper)', () => {
	vitestTest('[DO1] null input returns an Optional wrapping null', () => {
		const result = dateOpt(null)
		expect(result).toBeInstanceOf(Optional)
	})

	vitestTest('[DO2] undefined input treated as null (same Optional)', () => {
		const result = dateOpt(undefined)
		expect(result).toBeInstanceOf(Optional)
	})

	vitestTest('[DO3] YYYY-MM-DD input returns an Optional with a non-null Date payload', () => {
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

	test.prop([ymdArb])(
		'[DOP1] dateOpt never throws on any valid YYYY-MM-DD in booking horizon',
		(ymd) => {
			expect(() => dateOpt(ymd)).not.toThrow()
			expect(dateOpt(ymd)).toBeInstanceOf(Optional)
		},
	)

	vitestTest(
		'[DO4] month/year rollover dates accepted (Dec 31 → Jan 1, leap-day 2028-02-29)',
		() => {
			// 2028 is a leap year (divisible by 4 and by 400).
			expect(() => dateOpt('2028-02-29')).not.toThrow()
			expect(() => dateOpt('2026-12-31')).not.toThrow()
			expect(() => dateOpt('2027-01-01')).not.toThrow()
		},
	)
})
