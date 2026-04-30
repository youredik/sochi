/**
 * Strict tests для phone-format helpers (libphonenumber-js wrappers).
 *
 *   [PF1] formatRu — empty input returns empty
 *   [PF2] formatRu — applies AsYouType('RU') template
 *   [PF3] formatRu — idempotent on already-formatted value
 *   [PF4] isValidRuPhone — valid mobile number passes
 *   [PF5] isValidRuPhone — invalid number fails
 *   [PF6] isValidRuPhone — empty/null/short returns false
 *   [PF7] toE164 — extracts canonical E.164 form
 *   [PF8] toE164 — returns null for invalid
 *   [PF9] formatRu doesn't crash with weird whitespace + characters
 */

import { describe, expect, test } from 'vitest'
import { formatRu, isValidRuPhone, toE164 } from './phone-format.ts'

describe('formatRu', () => {
	test('[PF1] empty input returns empty', () => {
		expect(formatRu('')).toBe('')
	})

	test('[PF2] applies AsYouType template для RU', () => {
		// 79651234567 — valid RU mobile
		const formatted = formatRu('79651234567')
		expect(formatted).toMatch(/\+7/)
		// Не строгая форма — формат может быть «+7 965 123-45-67» или «+7 (965) 123-45-67»
		// в зависимости от libphonenumber-js metadata; suffices that it gets +7 prefix
		expect(formatted).toContain('965')
		expect(formatted).toContain('123')
	})

	test('[PF3] idempotent на already-formatted value', () => {
		const once = formatRu('79651234567')
		const twice = formatRu(once)
		expect(twice).toBe(once)
	})

	test('[PF9] не падает на whitespace + characters', () => {
		expect(() => formatRu('  +7 (965) 123 45 67  ')).not.toThrow()
		expect(() => formatRu('abc')).not.toThrow()
	})
})

describe('isValidRuPhone', () => {
	test('[PF4] valid RU mobile number passes', () => {
		expect(isValidRuPhone('+79651234567')).toBe(true)
		expect(isValidRuPhone('+7 965 123 45 67')).toBe(true)
		expect(isValidRuPhone('89651234567')).toBe(true)
	})

	test('[PF5] invalid number fails', () => {
		expect(isValidRuPhone('+79')).toBe(false)
		expect(isValidRuPhone('+712345')).toBe(false)
		expect(isValidRuPhone('not a phone')).toBe(false)
	})

	test('[PF6] empty / short returns false без exception', () => {
		expect(isValidRuPhone('')).toBe(false)
		expect(isValidRuPhone('123')).toBe(false)
	})
})

describe('toE164', () => {
	test('[PF7] extracts canonical E.164', () => {
		expect(toE164('+7 (965) 123-45-67')).toBe('+79651234567')
		expect(toE164('89651234567')).toBe('+79651234567')
		expect(toE164('+79651234567')).toBe('+79651234567')
	})

	test('[PF8] returns null для invalid', () => {
		expect(toE164('+79')).toBeNull()
		expect(toE164('not a phone')).toBeNull()
		expect(toE164('')).toBeNull()
	})
})
