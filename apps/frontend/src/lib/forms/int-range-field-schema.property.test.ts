/**
 * Property-based tests (fast-check) для `intRangeFieldSchema` — pure
 * function over (min, max, value). Per `[[fastcheck-gotchas]]`:
 *   - Property tests ONLY для pure functions
 *   - Bounded shrink space: ≤500 numRuns × tight integer ranges
 *
 * Invariants tested:
 *   [P-RANGE-1] для any (min, max) с min ≤ max, any v ∈ [min, max] —
 *               schema accepts String(v)
 *   [P-RANGE-2] для any v < min OR v > max — schema rejects + surfaces
 *               the canonical bound message
 *   [P-REGEX-1] для any non-empty string NOT matching `^-?\d+$` — schema
 *               rejects with «Целое число»
 *   [P-EMPTY-1] allowEmpty=true: '' accepted; allowEmpty=false: '' rejected
 *               with «Введите число»
 *   [P-MESSAGE-1] error message contains exact min/max numerically
 *                 (template literal contract)
 *   [P-DETERMINISTIC-1] safeParse is deterministic — same input → same
 *                       success/error tuple across runs
 */
import { describe, expect, test } from 'bun:test'
import * as fc from 'fast-check'
import { intRangeFieldSchema, intRangeNumberValidator } from './int-range-field-schema.ts'

// Bounded arbitraries — JS Number is safe to 2^53; we constrain к realistic
// inventory bounds to keep the shrink space minimal and the test stable.
const arbMinMax = fc
	.tuple(fc.integer({ min: -100, max: 100 }), fc.integer({ min: -100, max: 100 }))
	.map(([a, b]) => (a <= b ? { min: a, max: b } : { min: b, max: a }))

// fast-check's `assert` is overloaded — returns `void` for sync properties,
// `Promise<void>` for async ones. All our properties are sync, so the void
// overload applies; `void` prefix silences biome's `noFloatingPromises`
// rule, which doesn't pick the correct overload for our IProperty<Ts>.
describe('intRangeFieldSchema — property-based', () => {
	test('[P-RANGE-1] integer within [min, max] always accepted', () => {
		void fc.assert(
			fc.property(
				arbMinMax.chain((b) => fc.tuple(fc.constant(b), fc.integer({ min: b.min, max: b.max }))),
				([bounds, v]) => {
					const schema = intRangeFieldSchema(bounds)
					expect(schema.safeParse(String(v)).success).toBe(true)
				},
			),
			{ numRuns: 200 },
		)
	})

	test('[P-RANGE-2] integer outside [min, max] always rejected с canonical message', () => {
		void fc.assert(
			fc.property(arbMinMax, (bounds) => {
				const schema = intRangeFieldSchema(bounds)
				const below = bounds.min - 1
				const above = bounds.max + 1
				const belowResult = schema.safeParse(String(below))
				expect(belowResult.success).toBe(false)
				expect(belowResult.error?.issues[0]?.message).toBe(`Не меньше ${bounds.min}`)
				const aboveResult = schema.safeParse(String(above))
				expect(aboveResult.success).toBe(false)
				expect(aboveResult.error?.issues[0]?.message).toBe(`Не больше ${bounds.max}`)
			}),
			{ numRuns: 50 },
		)
	})

	test('[P-REGEX-1] non-empty string failing `^-?\\d+$` rejected с «Целое число»', () => {
		const schema = intRangeFieldSchema({ min: 1, max: 100 })
		const arbBadFormat = fc
			.string({ minLength: 1, maxLength: 10 })
			.filter((s) => s.length > 0 && !/^-?\d+$/.test(s))
		void fc.assert(
			fc.property(arbBadFormat, (s) => {
				const r = schema.safeParse(s)
				expect(r.success).toBe(false)
				expect(r.error?.issues[0]?.message).toBe('Целое число')
			}),
			{ numRuns: 100 },
		)
	})

	test('[P-EMPTY-1] allowEmpty semantic — true accepts «», false rejects с «Введите число»', () => {
		void fc.assert(
			fc.property(arbMinMax, (bounds) => {
				const optional = intRangeFieldSchema({ ...bounds, allowEmpty: true })
				expect(optional.safeParse('').success).toBe(true)

				const required = intRangeFieldSchema(bounds)
				const r = required.safeParse('')
				expect(r.success).toBe(false)
				expect(r.error?.issues[0]?.message).toBe('Введите число')
			}),
			{ numRuns: 25 },
		)
	})

	test('[P-MESSAGE-1] bound message contains exact min/max (template literal contract)', () => {
		void fc.assert(
			fc.property(arbMinMax, (bounds) => {
				const schema = intRangeFieldSchema(bounds)
				const belowMsg = schema.safeParse(String(bounds.min - 1)).error?.issues[0]?.message
				const aboveMsg = schema.safeParse(String(bounds.max + 1)).error?.issues[0]?.message
				expect(belowMsg).toContain(String(bounds.min))
				expect(aboveMsg).toContain(String(bounds.max))
			}),
			{ numRuns: 50 },
		)
	})

	test('[P-DETERMINISTIC-1] safeParse is deterministic — same input → same success/error', () => {
		void fc.assert(
			fc.property(
				arbMinMax,
				fc.oneof(
					fc.integer({ min: -200, max: 200 }).map(String),
					fc.constantFrom('', 'abc', '1.5'),
				),
				(bounds, input) => {
					const schema = intRangeFieldSchema(bounds)
					const r1 = schema.safeParse(input)
					const r2 = schema.safeParse(input)
					expect(r1.success).toBe(r2.success)
					if (!r1.success && !r2.success) {
						expect(r1.error?.issues[0]?.message).toBe(r2.error?.issues[0]?.message ?? '')
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})

/**
 * Property-based tests для `intRangeNumberValidator` (number-typed sibling).
 * Same canon as string variant but input shape differs (number | undefined).
 * Same 4 message families: «Введите число» / «Целое число» / «Не меньше N» /
 * «Не больше N» / undefined (pass).
 */
describe('intRangeNumberValidator — property-based', () => {
	test('[N-P-RANGE-1] integer within [min, max] always returns undefined (pass)', () => {
		void fc.assert(
			fc.property(
				arbMinMax.chain((b) => fc.tuple(fc.constant(b), fc.integer({ min: b.min, max: b.max }))),
				([bounds, v]) => {
					const validate = intRangeNumberValidator(bounds)
					expect(validate(v)).toBe(undefined)
				},
			),
			{ numRuns: 200 },
		)
	})

	test('[N-P-RANGE-2] integer outside [min, max] always rejected с canonical message', () => {
		void fc.assert(
			fc.property(arbMinMax, (bounds) => {
				const validate = intRangeNumberValidator(bounds)
				expect(validate(bounds.min - 1)).toBe(`Не меньше ${bounds.min}`)
				expect(validate(bounds.max + 1)).toBe(`Не больше ${bounds.max}`)
			}),
			{ numRuns: 50 },
		)
	})

	test('[N-P-INVALID-1] non-finite / undefined → «Введите число»', () => {
		const validate = intRangeNumberValidator({ min: 1, max: 100 })
		const arbInvalid = fc.oneof(
			fc.constantFrom(undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
		)
		void fc.assert(
			fc.property(arbInvalid, (input) => {
				expect(validate(input as number | undefined)).toBe('Введите число')
			}),
			{ numRuns: 20 },
		)
	})

	test('[N-P-DECIMAL-1] non-integer floats → «Целое число»', () => {
		const validate = intRangeNumberValidator({ min: 1, max: 100 })
		const arbDecimal = fc
			.double({ min: -1000, max: 1000, noNaN: true })
			.filter((n) => Number.isFinite(n) && !Number.isInteger(n))
		void fc.assert(
			fc.property(arbDecimal, (input) => {
				expect(validate(input)).toBe('Целое число')
			}),
			{ numRuns: 100 },
		)
	})

	test('[N-P-MESSAGE-1] bound message contains exact min/max (template literal contract)', () => {
		void fc.assert(
			fc.property(arbMinMax, (bounds) => {
				const validate = intRangeNumberValidator(bounds)
				expect(validate(bounds.min - 1)).toContain(String(bounds.min))
				expect(validate(bounds.max + 1)).toContain(String(bounds.max))
			}),
			{ numRuns: 50 },
		)
	})

	test('[N-P-PARITY-1] same messages с string variant for matching input pairs', () => {
		// String '' ↔ number undefined; string '21' ↔ number 21 — должны выдавать
		// идентичные RU messages для same trap class.
		void fc.assert(
			fc.property(arbMinMax, fc.integer({ min: -500, max: 500 }), (bounds, n) => {
				const numV = intRangeNumberValidator(bounds)
				const strV = intRangeFieldSchema(bounds)
				const numErr = numV(n) ?? null
				const strRes = strV.safeParse(String(n))
				const strErr = strRes.success ? null : (strRes.error.issues[0]?.message ?? null)
				// Either both pass (in range) or both fail с same message.
				expect(numErr).toBe(strErr)
			}),
			{ numRuns: 100 },
		)
	})
})
