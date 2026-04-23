import { describe, expect, it } from 'vitest'
import { formatErrors } from './format-errors.ts'

/**
 * Strict tests — exact-value output for every input shape TanStack Form
 * can emit into `field.state.meta.errors`. Hunts branch bugs in the
 * normalize() reducer.
 */
describe('formatErrors', () => {
	describe('string errors (common case from onSubmit return)', () => {
		it('single string → that string', () => {
			expect(formatErrors(['Обязательное поле'])).toBe('Обязательное поле')
		})

		it('multiple strings → comma-joined', () => {
			expect(formatErrors(['Поле пустое', 'Слишком короткое'])).toBe(
				'Поле пустое, Слишком короткое',
			)
		})
	})

	describe('object errors with message prop (Zod issues, custom validators)', () => {
		it('object with message → extracts message', () => {
			expect(formatErrors([{ message: 'Неверный email' }])).toBe('Неверный email')
		})

		it('Zod-like issue with path + message → uses message', () => {
			expect(
				formatErrors([{ path: ['email'], message: 'Invalid email', code: 'invalid_string' }]),
			).toBe('Invalid email')
		})

		it('mix of string + object → both normalized', () => {
			expect(formatErrors(['строка', { message: 'объект' }])).toBe('строка, объект')
		})
	})

	describe('edge cases (adversarial — every type TS-Form might emit)', () => {
		it('empty array → empty string', () => {
			expect(formatErrors([])).toBe('')
		})

		it('null in array → filtered out', () => {
			expect(formatErrors([null, 'real error'])).toBe('real error')
		})

		it('undefined in array → filtered out', () => {
			expect(formatErrors([undefined, 'real error'])).toBe('real error')
		})

		it('object WITHOUT message prop → generic fallback', () => {
			expect(formatErrors([{ code: 'weird', not_message: 'hidden' }])).toBe('Ошибка валидации')
		})

		it('object with non-string message → generic fallback', () => {
			expect(formatErrors([{ message: 42 }])).toBe('Ошибка валидации')
		})

		it('number primitive → generic fallback (not "42")', () => {
			expect(formatErrors([42])).toBe('Ошибка валидации')
		})

		it('boolean → generic fallback', () => {
			expect(formatErrors([false, true])).toBe('Ошибка валидации, Ошибка валидации')
		})

		it('all-null array → empty string', () => {
			expect(formatErrors([null, undefined, null])).toBe('')
		})
	})

	describe('immutability (input array is not mutated)', () => {
		it('does not mutate the input array', () => {
			const input = ['a', { message: 'b' }, null] as const
			const snapshot = [...input]
			formatErrors(input)
			expect(input).toEqual(snapshot)
		})
	})
})
