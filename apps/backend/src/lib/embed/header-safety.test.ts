/**
 * Header-safety unit tests — D24 (R2 F1 Critical, Apr 2026).
 *
 * Covers `assertHeaderSafe` + `assertOriginSafe` rejection cases for
 * CRLF / NUL injection attempts and origin-format violations.
 */

import { describe, expect, it } from 'vitest'
import { assertHeaderSafe, assertOriginSafe, HTTPS_ORIGIN_REGEX } from './header-safety.ts'

describe('assertHeaderSafe — CRLF + NUL rejection', () => {
	it('[H1] passes a clean ASCII value', () => {
		expect(() => assertHeaderSafe('https://hotel-aurora.ru', 'CSP test')).not.toThrow()
	})

	it('[H2] rejects \\r (CR-only header splice)', () => {
		expect(() => assertHeaderSafe('value\r', 'CSP test')).toThrow(/header-injection attempt/)
	})

	it('[H3] rejects \\n (LF-only header splice)', () => {
		expect(() => assertHeaderSafe('value\n', 'CSP test')).toThrow(/header-injection attempt/)
	})

	it('[H4] rejects \\r\\n (canonical CRLF Set-Cookie injection)', () => {
		expect(() => assertHeaderSafe('https://evil.ru\r\nSet-Cookie: x=y', 'CSP test')).toThrow(
			/header-injection attempt/,
		)
	})

	it('[H5] rejects NUL byte (header truncation attack)', () => {
		expect(() => assertHeaderSafe('https://host\x00trail', 'CSP test')).toThrow(
			/header-injection attempt/,
		)
	})

	it('[H6] context appears in throw message (forensic logging)', () => {
		try {
			assertHeaderSafe('bad\rvalue', 'frame-ancestors construction')
			throw new Error('unreachable')
		} catch (e) {
			expect((e as Error).message).toContain('frame-ancestors construction')
		}
	})
})

describe('assertOriginSafe — strict HTTPS allowlist', () => {
	it('[O1] passes canonical https://host', () => {
		expect(assertOriginSafe('https://hotel-aurora.ru', 'test')).toBe('https://hotel-aurora.ru')
	})

	it('[O2] passes https://host:port', () => {
		expect(assertOriginSafe('https://staging.aurora.ru:8443', 'test')).toBe(
			'https://staging.aurora.ru:8443',
		)
	})

	it('[O3] rejects http:// (insecure scheme)', () => {
		expect(() => assertOriginSafe('http://hotel-aurora.ru', 'test')).toThrow(
			/invalid origin format/,
		)
	})

	it('[O4] rejects scheme-less host', () => {
		expect(() => assertOriginSafe('hotel-aurora.ru', 'test')).toThrow(/invalid origin format/)
	})

	it('[O5] rejects path component', () => {
		expect(() => assertOriginSafe('https://hotel-aurora.ru/booking', 'test')).toThrow(
			/invalid origin format/,
		)
	})

	it('[O6] rejects Cyrillic hostname (must be punycode)', () => {
		expect(() => assertOriginSafe('https://отель-аврора.рф', 'test')).toThrow(
			/invalid origin format/,
		)
	})

	it('[O7] rejects CRLF embedded in origin string (defense composition)', () => {
		expect(() => assertOriginSafe('https://aurora.ru\r\nX-Evil: 1', 'test')).toThrow(
			/header-injection attempt/,
		)
	})

	it('[O8] regex is exported для shared zod write-side validation', () => {
		expect(HTTPS_ORIGIN_REGEX.test('https://host.example')).toBe(true)
		expect(HTTPS_ORIGIN_REGEX.test('http://host.example')).toBe(false)
	})
})
