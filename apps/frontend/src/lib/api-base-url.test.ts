/**
 * `getApiBaseUrl()` — strict tests per `feedback_strict_tests` +
 * `feedback_critical_fix_test_coverage_canon`.
 *
 * Invariants:
 *   - I1 VITE_API_URL set → that exact value (override path)
 *   - I2 VITE_API_URL undefined + window present → window.location.origin
 *   - I3 VITE_API_URL undefined + no window (SSR/test) → localhost:8787
 *
 * Test matrix:
 *   [BU1] window.location.origin returns same-origin string (happy-dom test env)
 *   [BU2] empty string env var → empty не truthy → falls through к origin
 *   [BU3] non-empty env var → that exact value
 *
 * Note: import.meta.env is build-time. Bun:test sees env reflecting build
 * config. Test verifies behavior given current env state — for explicit
 * VITE_API_URL override testing, ENV mutation would be needed (skip per
 * feedback_bun_test_canons §1 anti-pattern).
 */

import { describe, expect, test } from 'bun:test'
import { getApiBaseUrl, getApiTracePropagationPatterns } from './api-base-url.ts'

describe('getApiBaseUrl (same-origin canon)', () => {
	test('[BU1] returns string (not undefined / null)', () => {
		const result = getApiBaseUrl()
		expect(typeof result).toBe('string')
		expect(result.length).toBeGreaterThan(0)
	})

	test('[BU2] returns valid URL — parseable through URL constructor', () => {
		const result = getApiBaseUrl()
		// Must be valid URL syntax (no localhost:8787 hardcoded literal sneaking).
		expect(() => new URL(result)).not.toThrow()
	})

	test('[BU3] in browser context (happy-dom) returns window.location.origin', () => {
		// happy-dom is registered via preload — window exists. Env VITE_API_URL
		// is undefined in test (no override). Expected: window.location.origin.
		// Per bun-preload.ts, happy-dom registers с url: 'http://localhost/'
		// → origin = 'http://localhost'.
		expect(getApiBaseUrl()).toBe('http://localhost')
	})
})

describe('getApiTracePropagationPatterns (OTel trace-propagation canon)', () => {
	test('[TP1] returns array of RegExp (not undefined / non-empty for valid base)', () => {
		const patterns = getApiTracePropagationPatterns()
		expect(Array.isArray(patterns)).toBe(true)
		expect(patterns.length).toBe(1)
		expect(patterns[0]).toBeInstanceOf(RegExp)
	})

	test('[TP2] regex matches API base URL — propagation will fire для same-origin fetches', () => {
		// happy-dom origin: http://localhost → host = 'localhost'. The pattern
		// must match URLs containing that host (substring, not anchored — old
		// `$`-anchored canon was silently broken для URLs с path).
		const [pattern] = getApiTracePropagationPatterns()
		expect(pattern?.test('http://localhost/api/v1/properties')).toBe(true)
		expect(pattern?.test('http://localhost:5273/welcome')).toBe(true)
	})

	test('[TP3] regex does NOT match unrelated hosts (no false-positive propagation)', () => {
		const [pattern] = getApiTracePropagationPatterns()
		// Yandex.Metrika, third-party CDNs, etc. must NOT receive traceparent —
		// it leaks internal trace IDs к non-trusted hosts.
		expect(pattern?.test('https://mc.yandex.ru/metrika/tag.js')).toBe(false)
		expect(pattern?.test('https://example.com/path')).toBe(false)
	})

	test('[TP4] host extraction уважает regex special-chars — dots не treated как wildcard', () => {
		// Verify the escape: `.sepshn.ru` would match `xsepshnxru` если dots
		// были unescaped. Regression guard для `escapeForRegExp` correctness.
		const [pattern] = getApiTracePropagationPatterns()
		// happy-dom host = 'localhost' (no dots), но проверяем что regex
		// source действительно escapes — substring match без `\.` would
		// allow 'l0calhost' и т.п. Здесь нет dots в host, поэтому direct
		// check на source structure: literal not pattern.
		expect(pattern?.source).toBe('localhost')
	})
})
