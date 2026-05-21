/**
 * `resolveAppHostRedirect()` — strict tests per `feedback_strict_tests` +
 * `feedback_critical_fix_test_coverage_canon`. Pure-function canon
 * (no DOM, no `window`, no fetch — easiest possible test surface).
 *
 * Invariants:
 *   - I1 Apex + app-path → redirect к demo subdomain (preserves search)
 *   - I2 Apex + landing path `/` → null (stays на apex)
 *   - I3 Apex + `/legal/*` → null (marketing surface stays на apex)
 *   - I4 App subdomain → null (already on app, no redirect)
 *   - I5 Localhost dev → null (never redirect in dev/test)
 *   - I6 Unknown host → null (defensive default — don't redirect strangers)
 *   - I7 Case-insensitive host matching
 *   - I8 www prefix also treated as apex
 */

import { describe, expect, test } from 'bun:test'
import { resolveAppHostRedirect } from './apex-redirect.ts'

describe('resolveAppHostRedirect — apex → app canonical', () => {
	test('[AR1] apex + /login → redirects to demo subdomain', () => {
		expect(resolveAppHostRedirect('sepshn.ru', '/login', '')).toBe('https://demo.sepshn.ru/login')
	})

	test('[AR2] apex + /signup with query → preserves query string', () => {
		expect(resolveAppHostRedirect('sepshn.ru', '/signup', '?utm=marketing')).toBe(
			'https://demo.sepshn.ru/signup?utm=marketing',
		)
	})

	test('[AR3] apex + /welcome → redirects (post-magic-link surface)', () => {
		expect(resolveAppHostRedirect('sepshn.ru', '/welcome', '?n=Test')).toBe(
			'https://demo.sepshn.ru/welcome?n=Test',
		)
	})

	test('[AR4] apex + /o/{slug}/grid → redirects (deep app link)', () => {
		expect(resolveAppHostRedirect('sepshn.ru', '/o/testorg/grid', '')).toBe(
			'https://demo.sepshn.ru/o/testorg/grid',
		)
	})

	test('[AR5] apex + / (landing) → null (stays on apex)', () => {
		expect(resolveAppHostRedirect('sepshn.ru', '/', '')).toBe(null)
	})

	test('[AR6] apex + /legal/privacy → null (marketing surface)', () => {
		expect(resolveAppHostRedirect('sepshn.ru', '/legal/privacy', '')).toBe(null)
	})

	test('[AR6b] apex + /privacy → null (152-ФЗ privacy page lives on apex)', () => {
		expect(resolveAppHostRedirect('sepshn.ru', '/privacy', '')).toBe(null)
	})

	test('[AR7] app subdomain demo.sepshn.ru → null (already on app)', () => {
		expect(resolveAppHostRedirect('demo.sepshn.ru', '/login', '')).toBe(null)
	})

	test('[AR8] localhost dev → null (no redirect during dev)', () => {
		expect(resolveAppHostRedirect('localhost', '/login', '')).toBe(null)
	})

	test('[AR9] case-insensitive — uppercase host treated like apex', () => {
		expect(resolveAppHostRedirect('SEPSHN.RU', '/login', '')).toBe('https://demo.sepshn.ru/login')
	})

	test('[AR10] www prefix also redirects', () => {
		expect(resolveAppHostRedirect('www.sepshn.ru', '/login', '')).toBe(
			'https://demo.sepshn.ru/login',
		)
	})

	test('[AR11] unknown host → null (defensive default)', () => {
		expect(resolveAppHostRedirect('attacker.example.com', '/login', '')).toBe(null)
	})

	test('[AR12] apex root with trailing query (e.g. UTM) → null (landing-with-tracking)', () => {
		expect(resolveAppHostRedirect('sepshn.ru', '/', '?utm_source=tg')).toBe(null)
	})
})
