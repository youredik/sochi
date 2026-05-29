/**
 * Тесты единого user-message слоя (booking/guest UX refactor 2026-05-29).
 *
 * Главный инвариант: пользователю НИКОГДА не уходит сырое dev-сообщение.
 * Известный код → RU из словаря; неизвестный → fallback; CLIENT_VALIDATION
 * (наши доверенные RU) → как есть.
 */

import { describe, expect, it } from 'bun:test'
import { ERROR_CODE_MESSAGES, GENERIC_ERROR_MESSAGE, userMessageFor } from './user-message.ts'

describe('userMessageFor', () => {
	it('известный код → RU из словаря', () => {
		expect(userMessageFor({ code: 'NO_INVENTORY', message: 'whatever' })).toBe(
			ERROR_CODE_MESSAGES.NO_INVENTORY as string,
		)
		expect(userMessageFor({ code: 'PASSPORT_SCAN_REQUIRED', message: 'x' })).toContain('скан')
	})

	it('НИКОГДА не возвращает сырое dev-сообщение для неизвестного кода', () => {
		const raw = 'buildGuestCreateBody: documentNumber required'
		const out = userMessageFor({ code: 'SOME_UNKNOWN_CODE', message: raw })
		expect(out).not.toBe(raw)
		expect(out).not.toContain('buildGuestCreateBody')
		expect(out).toBe(GENERIC_ERROR_MESSAGE)
	})

	it('нет code → контекстный fallback (не raw message)', () => {
		const raw = 'TypeError: cannot read x of undefined'
		expect(userMessageFor({ message: raw }, 'Не удалось создать бронь')).toBe(
			'Не удалось создать бронь',
		)
		expect(userMessageFor({ message: raw }, 'Не удалось создать бронь')).not.toContain('TypeError')
	})

	it('default fallback = generic, когда контекст не задан', () => {
		expect(userMessageFor({ message: 'boom' })).toBe(GENERIC_ERROR_MESSAGE)
	})

	it('CLIENT_VALIDATION → показывает наше доверенное RU-сообщение как есть', () => {
		expect(userMessageFor({ code: 'CLIENT_VALIDATION', message: 'Укажите имя гостя' })).toBe(
			'Укажите имя гостя',
		)
	})

	it('CLIENT_VALIDATION с пустым message → RU из словаря (не пустота, не raw)', () => {
		expect(userMessageFor({ code: 'CLIENT_VALIDATION', message: '' })).toBe(
			ERROR_CODE_MESSAGES.CLIENT_VALIDATION as string,
		)
	})

	it('полностью неizвестный объект / null → generic', () => {
		expect(userMessageFor(null)).toBe(GENERIC_ERROR_MESSAGE)
		expect(userMessageFor(undefined)).toBe(GENERIC_ERROR_MESSAGE)
		expect(userMessageFor('string error')).toBe(GENERIC_ERROR_MESSAGE)
	})

	it('каждое сообщение словаря — непустая строка на кириллице', () => {
		for (const [code, msg] of Object.entries(ERROR_CODE_MESSAGES)) {
			expect(msg.length, code).toBeGreaterThan(0)
			expect(/[А-Яа-я]/.test(msg), code).toBe(true)
		}
	})
})
