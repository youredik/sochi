/**
 * SMS adapter types — pure-fn helper tests (P3, 2026-05-19).
 *
 * Coverage:
 *   - normalizePhoneE164: RU/intl/whitespace/parens-dashes
 *   - normalizePhoneE164: rejects malformed (no +, too short, letters, CRLF)
 *   - maskPhoneE164: RU + international formats + edge cases
 */

import { describe, expect, test } from 'bun:test'
import { maskPhoneE164, normalizePhoneE164 } from './sms-adapter.types.ts'

describe('normalizePhoneE164', () => {
	test('canonical E.164 passthrough', () => {
		expect(normalizePhoneE164('+79991234567')).toBe('+79991234567')
		expect(normalizePhoneE164('+12025550100')).toBe('+12025550100')
		expect(normalizePhoneE164('+442071234567')).toBe('+442071234567')
	})

	test('strips formatting chars (spaces / dashes / parens)', () => {
		expect(normalizePhoneE164('+7 (999) 123-45-67')).toBe('+79991234567')
		expect(normalizePhoneE164('+1 202-555-0100')).toBe('+12025550100')
		expect(normalizePhoneE164('+44 20 7123 4567')).toBe('+442071234567')
	})

	test('rejects missing + prefix', () => {
		expect(normalizePhoneE164('79991234567')).toBeNull()
		expect(normalizePhoneE164('89991234567')).toBeNull()
	})

	test('rejects too short / too long', () => {
		expect(normalizePhoneE164('+7999')).toBeNull() // 4 digits
		expect(normalizePhoneE164('+123456')).toBeNull() // 6 digits
		expect(normalizePhoneE164(`+${'9'.repeat(16)}`)).toBeNull() // 16 digits
	})

	test('rejects non-digit chars', () => {
		expect(normalizePhoneE164('+7abc1234567')).toBeNull()
		expect(normalizePhoneE164('+7999abc4567')).toBeNull()
	})

	test('rejects empty / whitespace-only', () => {
		expect(normalizePhoneE164('')).toBeNull()
		expect(normalizePhoneE164('   ')).toBeNull()
	})

	test('CRLF / TAB stripped к canonical (\\s normalization, defense-in-depth)', () => {
		// `\s` regex matches \r\n\t — stripped BEFORE E.164 validation.
		// Result: canonical phone returned, CRLF never propagates. Caller
		// uses normalized value (not raw) downstream → no header smuggle risk.
		expect(normalizePhoneE164('+7999\r\n1234567')).toBe('+79991234567')
		expect(normalizePhoneE164('+7999\n1234567')).toBe('+79991234567')
		expect(normalizePhoneE164('+7\t9991234567')).toBe('+79991234567')
	})
})

describe('maskPhoneE164', () => {
	// Canon: + + first-cc-digit + (N-3 asterisks) + last 2 digits.
	// 11-digit phone (RU/US): 1 + 8*N + 2 = total 12 chars (incl +).
	// 12-digit phone (UK):    1 + 9*N + 2 = total 13 chars (incl +).
	test('RU 11-digit', () => {
		expect(maskPhoneE164('+79991234567')).toBe('+7********67')
	})

	test('US 11-digit', () => {
		expect(maskPhoneE164('+12025550100')).toBe('+1********00')
	})

	test('UK 12-digit', () => {
		expect(maskPhoneE164('+442071234567')).toBe('+4*********67')
	})

	test('mask preserves +, country first digit, last 2 — middle = asterisks', () => {
		const masked = maskPhoneE164('+79991234567')
		expect(masked.startsWith('+7')).toBe(true)
		expect(masked.endsWith('67')).toBe(true)
		expect(masked.includes('999')).toBe(false) // middle masked
		// 11 digits — first 1 + last 2 = 3 visible; remaining 8 masked.
		expect(masked.split('*').length - 1).toBe(8)
	})

	test('malformed input → safe placeholder', () => {
		expect(maskPhoneE164('not-a-phone')).toBe('<invalid-phone>')
		expect(maskPhoneE164('+7abc')).toBe('<invalid-phone>')
		expect(maskPhoneE164('')).toBe('<invalid-phone>')
	})
})
