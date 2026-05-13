/**
 * extractMagicLinkUrl — strict tests.
 *
 * Pre-done audit:
 *   [R1] extracts URL embedded in `<a href="…">` (HTML attribute, double-quote)
 *   [R2] extracts URL embedded in `<a href='…'>` (single-quote)
 *   [R3] extracts plain-text URL surrounded by whitespace
 *   [R4] extracts URL with multiple query params (token + callbackURL)
 *   [R5] picks the FIRST URL когда email contains multiple verify links
 *        (HTML + text variants in same body — common BA pattern)
 *   [N1] returns null когда no verify URL present (other email subject)
 *   [N2] returns null on empty string
 *   [N3] returns null когда only non-magic-link URL present
 *   [H1] host/port-agnostic: localhost:8787 matches
 *   [H2] host/port-agnostic: staging.sochi.ru:443 matches
 *   [H3] host/port-agnostic: HTTPS without explicit port matches
 *   [Q1] URL with URL-encoded query value (callbackURL=…) extracted intact
 *   [E1] does NOT extract URL containing `<` (would be malformed HTML)
 */
import { describe, expect, it } from 'bun:test'
import { extractMagicLinkUrl } from './email-magic-link-url.ts'

describe('extractMagicLinkUrl — happy paths', () => {
	it('[R1] extracts URL from <a href="…"> (double-quote attribute)', () => {
		const body =
			'<a href="http://localhost:8787/api/auth/magic-link/verify?token=abc&callbackURL=%2F">click</a>'
		expect(extractMagicLinkUrl(body)).toBe(
			'http://localhost:8787/api/auth/magic-link/verify?token=abc&callbackURL=%2F',
		)
	})

	it("[R2] extracts URL from <a href='…'> (single-quote attribute)", () => {
		const body = "<a href='http://localhost:8787/api/auth/magic-link/verify?token=def'>click</a>"
		expect(extractMagicLinkUrl(body)).toBe(
			'http://localhost:8787/api/auth/magic-link/verify?token=def',
		)
	})

	it('[R3] extracts plain-text URL surrounded by whitespace', () => {
		const body =
			'Войдите по ссылке: http://localhost:8787/api/auth/magic-link/verify?token=ghi  — действует 5 минут'
		expect(extractMagicLinkUrl(body)).toBe(
			'http://localhost:8787/api/auth/magic-link/verify?token=ghi',
		)
	})

	it('[R4] extracts URL с multiple query params', () => {
		const body =
			'http://localhost:8787/api/auth/magic-link/verify?token=long-jwt-here.payload.sig&callbackURL=http%3A%2F%2Flocalhost%2Fwelcome%3Fn%3DTest'
		expect(extractMagicLinkUrl(body)).toBe(
			'http://localhost:8787/api/auth/magic-link/verify?token=long-jwt-here.payload.sig&callbackURL=http%3A%2F%2Flocalhost%2Fwelcome%3Fn%3DTest',
		)
	})

	it('[R5] picks the FIRST verify URL когда multiple present (HTML + text variants)', () => {
		const body = `
			<a href="http://localhost:8787/api/auth/magic-link/verify?token=first">click</a>
			Or copy: http://localhost:8787/api/auth/magic-link/verify?token=second
		`
		// First-match semantics — JS regex returns the leftmost-longest match.
		expect(extractMagicLinkUrl(body)).toBe(
			'http://localhost:8787/api/auth/magic-link/verify?token=first',
		)
	})
})

describe('extractMagicLinkUrl — host/port agnostic', () => {
	it('[H1] localhost:8787 matches', () => {
		const body = 'http://localhost:8787/api/auth/magic-link/verify?token=x'
		expect(extractMagicLinkUrl(body)).toBe(body)
	})

	it('[H2] staging host с explicit port matches', () => {
		const body = 'https://staging.sochi.ru:8443/api/auth/magic-link/verify?token=stg'
		expect(extractMagicLinkUrl(body)).toBe(body)
	})

	it('[H3] HTTPS без explicit port matches', () => {
		const body = 'https://app.sochi.ru/api/auth/magic-link/verify?token=prod'
		expect(extractMagicLinkUrl(body)).toBe(body)
	})
})

describe('extractMagicLinkUrl — query-encoded values', () => {
	it('[Q1] callbackURL с URL-encoded орг-name extracted intact', () => {
		const encoded = encodeURIComponent('Гостиница Ромашка')
		const body = `http://localhost:8787/api/auth/magic-link/verify?token=z&callbackURL=http%3A%2F%2Flocalhost%2Fwelcome%3Fn%3D${encoded}`
		expect(extractMagicLinkUrl(body)).toBe(body)
	})
})

describe('extractMagicLinkUrl — negative paths', () => {
	it('[N1] returns null on body без verify URL (other email)', () => {
		const body =
			'<a href="http://localhost:8787/api/v1/properties">other endpoint</a> non-auth email body'
		expect(extractMagicLinkUrl(body)).toBe(null)
	})

	it('[N2] returns null on empty string', () => {
		expect(extractMagicLinkUrl('')).toBe(null)
	})

	it('[N3] returns null когда URL не has /api/auth/magic-link/verify path', () => {
		const body = 'http://localhost:8787/some/other/path?token=x'
		expect(extractMagicLinkUrl(body)).toBe(null)
	})
})

describe('extractMagicLinkUrl — edge cases', () => {
	it('[E1] terminates extraction at HTML-attribute terminator', () => {
		// URL ends at the closing `"` of the href attribute; trailing `> text </a>`
		// must NOT be part of the extracted string.
		const body = '<a href="http://localhost:8787/api/auth/magic-link/verify?token=safe">click</a>'
		const url = extractMagicLinkUrl(body)
		expect(url).not.toBe(null)
		if (url !== null) {
			expect(url.includes('">')).toBe(false)
			expect(url.includes('<')).toBe(false)
		}
	})
})
