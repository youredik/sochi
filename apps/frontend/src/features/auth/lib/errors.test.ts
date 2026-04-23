import { describe, expect, it } from 'vitest'
import { mapAuthError } from './errors.ts'

/**
 * Strict tests for mapAuthError — ensures each BA error code maps to the
 * correct localized UX, unknown codes fall back gracefully, and 4xx status
 * flags blocking correctly. Exact-value asserts on `title`/`blocking`/
 * `actionResend` — any accidental copy change is immediately visible.
 */
describe('mapAuthError', () => {
	describe('known Better Auth codes (exact copy)', () => {
		it('INVALID_EMAIL_OR_PASSWORD → non-blocking with corrective hint', () => {
			const r = mapAuthError({ code: 'INVALID_EMAIL_OR_PASSWORD' })
			expect(r.title).toBe('Неверный email или пароль')
			expect(r.description).toBe('Проверьте введённые данные и попробуйте ещё раз.')
			expect(r.blocking).toBeUndefined()
			expect(r.actionResend).toBeUndefined()
		})

		it('USER_ALREADY_EXISTS → non-blocking, suggests recovery', () => {
			const r = mapAuthError({ code: 'USER_ALREADY_EXISTS' })
			expect(r.title).toBe('Пользователь с таким email уже зарегистрирован')
			expect(r.description).toMatch(/[Вв]ойдите/)
		})

		it('EMAIL_NOT_VERIFIED → sets actionResend flag', () => {
			const r = mapAuthError({ code: 'EMAIL_NOT_VERIFIED' })
			expect(r.title).toBe('Email не подтверждён')
			expect(r.actionResend).toBe(true)
			expect(r.blocking).toBeUndefined()
		})

		it('PASSWORD_TOO_SHORT → describes 8-char minimum exactly', () => {
			const r = mapAuthError({ code: 'PASSWORD_TOO_SHORT' })
			expect(r.title).toBe('Пароль слишком короткий')
			expect(r.description).toBe('Минимум 8 символов.')
		})

		it('TOO_MANY_REQUESTS (code) → blocking=true', () => {
			const r = mapAuthError({ code: 'TOO_MANY_REQUESTS' })
			expect(r.blocking).toBe(true)
		})
	})

	describe('case insensitivity on code', () => {
		it('lowercase code is normalised to uppercase match', () => {
			const r = mapAuthError({ code: 'invalid_email_or_password' })
			expect(r.title).toBe('Неверный email или пароль')
		})
	})

	describe('status-driven fallback when code absent', () => {
		it('429 → blocking=true even without code', () => {
			const r = mapAuthError({ status: 429 })
			expect(r.title).toBe('Слишком много попыток')
			expect(r.blocking).toBe(true)
		})

		it('403 → blocking=true, surfaces server message', () => {
			const r = mapAuthError({ status: 403, message: 'Нет доступа к организации' })
			expect(r.title).toBe('Доступ запрещён')
			expect(r.description).toBe('Нет доступа к организации')
			expect(r.blocking).toBe(true)
		})

		it('403 without message → sensible default', () => {
			const r = mapAuthError({ status: 403 })
			expect(r.description).toBe('Нет прав на это действие.')
		})
	})

	describe('unknown code / no code, no status', () => {
		it('unknown code → generic fallback, no blocking', () => {
			const r = mapAuthError({ code: 'DOES_NOT_EXIST', message: 'raw server msg' })
			expect(r.title).toBe('Не удалось выполнить действие')
			expect(r.description).toBe('raw server msg')
			expect(r.blocking).toBeUndefined()
		})

		it('entirely empty error object → generic fallback with safe default text', () => {
			const r = mapAuthError({})
			expect(r.title).toBe('Не удалось выполнить действие')
			expect(r.description).toContain('Попробуйте ещё раз')
		})
	})

	describe('precedence: code beats status', () => {
		it('INVALID_EMAIL_OR_PASSWORD + 429 → code wins (non-blocking)', () => {
			const r = mapAuthError({ code: 'INVALID_EMAIL_OR_PASSWORD', status: 429 })
			expect(r.title).toBe('Неверный email или пароль')
			expect(r.blocking).toBeUndefined()
		})
	})
})
