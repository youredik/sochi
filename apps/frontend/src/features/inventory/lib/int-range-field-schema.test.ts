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
import { intRangeFieldSchema } from './int-range-field-schema.ts'

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
