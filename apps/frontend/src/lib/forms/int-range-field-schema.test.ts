/**
 * `intRangeFieldSchema` — strict adversarial tests for the canonical inline
 * integer-bound helper used by inventory admin forms. Each case asserts the
 * exact RU message; this is the contract that `<FieldError>` renders.
 *
 * Pre-done audit (per `[[strict_tests]]`):
 *   Valid:
 *     [V1..V3] min boundary / max boundary / mid range
 *   Adversarial — invalid format:
 *     [E1] '' → «Введите число»          (empty)
 *     [E2] 'abc' → «Целое число»         (letters)
 *     [E3] '1.5' → «Целое число»         (decimal)
 *     [E4] '-' → «Целое число»           (lone minus)
 *     [E5] ' 5 ' → «Целое число»         (whitespace — regex anchored)
 *   Adversarial — below min:
 *     [B1] '0' with min=1 → «Не меньше 1»
 *     [B2] '-5' with min=1 → «Не меньше 1»  (regex permits leading minus)
 *   Adversarial — above max:
 *     [A1] '21' with max=20 → «Не больше 20»
 *     [A2] '999999' with max=20 → «Не больше 20»
 *   min=0 (cancellationHours: 0..720):
 *     [Z1] '0' valid; [Z2] '-1' below; [Z3] '721' above
 *   Immutable bounds (template literal — bounds reflected verbatim):
 *     [I1] custom min/max numbers reflected verbatim in messages
 */
import { describe, expect, it } from 'bun:test'
import { intRangeFieldSchema, intRangeNumberValidator } from './int-range-field-schema.ts'

describe('intRangeFieldSchema — valid', () => {
	const schema = intRangeFieldSchema({ min: 1, max: 20 })

	it('[V1] accepts min boundary', () => {
		expect(schema.safeParse('1').success).toBe(true)
	})

	it('[V2] accepts max boundary', () => {
		expect(schema.safeParse('20').success).toBe(true)
	})

	it('[V3] accepts integer in middle of range', () => {
		expect(schema.safeParse('10').success).toBe(true)
	})
})

describe('intRangeFieldSchema — invalid format', () => {
	const schema = intRangeFieldSchema({ min: 1, max: 20 })

	it('[E1] empty string → «Введите число»', () => {
		const r = schema.safeParse('')
		expect(r.success).toBe(false)
		expect(r.error?.issues[0]?.message).toBe('Введите число')
	})

	it('[E2] letters → «Целое число»', () => {
		const r = schema.safeParse('abc')
		expect(r.success).toBe(false)
		expect(r.error?.issues[0]?.message).toBe('Целое число')
	})

	it('[E3] decimal → «Целое число»', () => {
		const r = schema.safeParse('1.5')
		expect(r.success).toBe(false)
		expect(r.error?.issues[0]?.message).toBe('Целое число')
	})

	it('[E4] lone minus → «Целое число»', () => {
		const r = schema.safeParse('-')
		expect(r.success).toBe(false)
		expect(r.error?.issues[0]?.message).toBe('Целое число')
	})

	it('[E5] surrounding whitespace → «Целое число» (regex anchored)', () => {
		const r = schema.safeParse(' 5 ')
		expect(r.success).toBe(false)
		expect(r.error?.issues[0]?.message).toBe('Целое число')
	})
})

describe('intRangeFieldSchema — below min', () => {
	const schema = intRangeFieldSchema({ min: 1, max: 20 })

	it('[B1] 0 with min=1 → «Не меньше 1»', () => {
		const r = schema.safeParse('0')
		expect(r.success).toBe(false)
		expect(r.error?.issues[0]?.message).toBe('Не меньше 1')
	})

	it('[B2] -5 with min=1 → «Не меньше 1» (negative parsed as int)', () => {
		const r = schema.safeParse('-5')
		expect(r.success).toBe(false)
		expect(r.error?.issues[0]?.message).toBe('Не меньше 1')
	})
})

describe('intRangeFieldSchema — above max', () => {
	const schema = intRangeFieldSchema({ min: 1, max: 20 })

	it('[A1] 21 with max=20 → «Не больше 20»', () => {
		const r = schema.safeParse('21')
		expect(r.success).toBe(false)
		expect(r.error?.issues[0]?.message).toBe('Не больше 20')
	})

	it('[A2] 999999 with max=20 → «Не больше 20»', () => {
		const r = schema.safeParse('999999')
		expect(r.success).toBe(false)
		expect(r.error?.issues[0]?.message).toBe('Не больше 20')
	})
})

describe('intRangeFieldSchema — min=0 case (mirrors cancellationHours)', () => {
	const schema = intRangeFieldSchema({ min: 0, max: 720 })

	it('[Z1] 0 valid when min=0', () => {
		expect(schema.safeParse('0').success).toBe(true)
	})

	it('[Z2] -1 with min=0 → «Не меньше 0»', () => {
		const r = schema.safeParse('-1')
		expect(r.success).toBe(false)
		expect(r.error?.issues[0]?.message).toBe('Не меньше 0')
	})

	it('[Z3] 721 with max=720 → «Не больше 720»', () => {
		const r = schema.safeParse('721')
		expect(r.success).toBe(false)
		expect(r.error?.issues[0]?.message).toBe('Не больше 720')
	})
})

describe('intRangeFieldSchema — immutable bounds (template literal contract)', () => {
	it('[I1] arbitrary min/max reflected verbatim in messages', () => {
		const schema = intRangeFieldSchema({ min: 7, max: 42 })
		expect(schema.safeParse('6').error?.issues[0]?.message).toBe('Не меньше 7')
		expect(schema.safeParse('43').error?.issues[0]?.message).toBe('Не больше 42')
		expect(schema.safeParse('7').success).toBe(true)
		expect(schema.safeParse('42').success).toBe(true)
	})
})

describe('intRangeFieldSchema — allowEmpty variant', () => {
	const schema = intRangeFieldSchema({ min: -5, max: 50, allowEmpty: true })

	it('[O1] empty string passes silently (no «Введите число»)', () => {
		expect(schema.safeParse('').success).toBe(true)
	})

	it('[O2] valid integer in range still passes', () => {
		expect(schema.safeParse('5').success).toBe(true)
	})

	it('[O3] valid negative integer (mirrors floorSchema -5..50)', () => {
		expect(schema.safeParse('-5').success).toBe(true)
	})

	it('[O4] non-empty malformed still rejected → «Целое число»', () => {
		const r = schema.safeParse('abc')
		expect(r.success).toBe(false)
		expect(r.error?.issues[0]?.message).toBe('Целое число')
	})

	it('[O5] non-empty below-min rejected → «Не меньше -5»', () => {
		const r = schema.safeParse('-6')
		expect(r.success).toBe(false)
		expect(r.error?.issues[0]?.message).toBe('Не меньше -5')
	})

	it('[O6] non-empty above-max rejected → «Не больше 50»', () => {
		const r = schema.safeParse('51')
		expect(r.success).toBe(false)
		expect(r.error?.issues[0]?.message).toBe('Не больше 50')
	})

	it('[O7] required variant (allowEmpty defaults false) still rejects empty', () => {
		const required = intRangeFieldSchema({ min: 1, max: 10 })
		const r = required.safeParse('')
		expect(r.success).toBe(false)
		expect(r.error?.issues[0]?.message).toBe('Введите число')
	})
})

/**
 * `intRangeNumberValidator` — TanStack-Form validator function variant
 * (number | undefined input). Same 4-message canon as `intRangeFieldSchema`,
 * different input shape. Used by booking-create-dialog `guestsCount` field
 * (`<TextField type="number">` coerces via valueAsNumber).
 *
 *   undefined / NaN  → «Введите число»
 *   non-integer      → «Целое число»
 *   below min        → «Не меньше {min}»
 *   above max        → «Не больше {max}»
 *   valid → undefined (validator-canonical pass)
 */
describe('intRangeNumberValidator', () => {
	const validate = intRangeNumberValidator({ min: 1, max: 20 })

	describe('valid', () => {
		it('[N-V1] min boundary returns undefined', () => {
			expect(validate(1)).toBe(undefined)
		})
		it('[N-V2] max boundary returns undefined', () => {
			expect(validate(20)).toBe(undefined)
		})
		it('[N-V3] mid range returns undefined', () => {
			expect(validate(10)).toBe(undefined)
		})
	})

	describe('adversarial — invalid input shape', () => {
		it('[N-E1] undefined → «Введите число» (TextField empty state)', () => {
			expect(validate(undefined)).toBe('Введите число')
		})
		it('[N-E2] NaN → «Введите число»', () => {
			expect(validate(Number.NaN)).toBe('Введите число')
		})
		it('[N-E3] +Infinity → «Введите число»', () => {
			expect(validate(Number.POSITIVE_INFINITY)).toBe('Введите число')
		})
		it('[N-E4] -Infinity → «Введите число»', () => {
			expect(validate(Number.NEGATIVE_INFINITY)).toBe('Введите число')
		})
		it('[N-E5] decimal (1.5) → «Целое число»', () => {
			expect(validate(1.5)).toBe('Целое число')
		})
	})

	describe('adversarial — out of range', () => {
		it('[N-B1] 0 with min=1 → «Не меньше 1»', () => {
			expect(validate(0)).toBe('Не меньше 1')
		})
		it('[N-B2] -5 with min=1 → «Не меньше 1»', () => {
			expect(validate(-5)).toBe('Не меньше 1')
		})
		it('[N-A1] 21 with max=20 → «Не больше 20»', () => {
			expect(validate(21)).toBe('Не больше 20')
		})
		it('[N-A2] 999999 with max=20 → «Не больше 20»', () => {
			expect(validate(999999)).toBe('Не больше 20')
		})
	})

	describe('immutable bounds (template literal contract)', () => {
		it('[N-I1] arbitrary min/max reflected verbatim', () => {
			const v = intRangeNumberValidator({ min: 7, max: 42 })
			expect(v(6)).toBe('Не меньше 7')
			expect(v(43)).toBe('Не больше 42')
			expect(v(7)).toBe(undefined)
			expect(v(42)).toBe(undefined)
		})
	})

	describe('parallel canon с string variant (intRangeFieldSchema)', () => {
		it('[N-P1] same messages для same trap inputs', () => {
			// String variant: empty → «Введите число»; number variant: undefined → same.
			expect(validate(undefined)).toBe(
				intRangeFieldSchema({ min: 1, max: 20 }).safeParse('').error?.issues[0]?.message,
			)
			// String '21' fails «Не больше 20»; number 21 same.
			expect(validate(21)).toBe(
				intRangeFieldSchema({ min: 1, max: 20 }).safeParse('21').error?.issues[0]?.message,
			)
		})
	})
})
