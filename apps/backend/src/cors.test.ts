/**
 * CORS allowlist — strict tests (Round 7 v3 P0 fix 2026-05-25).
 *
 * Gap-analysis P0 (empirical curl 2026-05-25):
 *   OPTIONS https://demo.sepshn.ru/api/v1/auth/sign-in/magic-link \
 *     -H 'Origin: https://attacker.example'
 *   → access-control-allow-origin: *  +  access-control-allow-credentials: true
 *
 * Invalid CORS (browsers reject `*`+credentials) but signals misconfig.
 * Function-style `resolveCorsOrigin` returns matched value or null →
 * Hono omits ACAO header entirely → preflight fails для untrusted origin.
 *
 * Test matrix:
 *   [C1] origin in allowlist → echoes back origin
 *   [C2] origin NOT in allowlist → null
 *   [C3] empty string origin → null
 *   [C4] case-sensitive match (canonical CORS — schema+host+port exact)
 *   [C5] trailing slash differs → null (canonical CORS — no normalization)
 */
import { describe, expect, test } from 'bun:test'
import { corsAllowlist, resolveCorsOrigin } from './app.ts'

describe('resolveCorsOrigin — function-style canonical allowlist', () => {
	test('[C1] origin in allowlist → echoed', () => {
		// `corsAllowlist` is populated from env at module-load; in test env
		// BETTER_AUTH_URL default = 'http://localhost:4000' OR test fixture sets
		// BETTER_AUTH_TRUSTED_ORIGINS. Either way, the first entry в allowlist
		// is the canonical local-dev origin. Test against that empirical entry.
		expect(corsAllowlist.length).toBeGreaterThan(0)
		const allowed = corsAllowlist[0]
		if (allowed) {
			expect(resolveCorsOrigin(allowed)).toBe(allowed)
		}
	})

	test('[C2] attacker origin → null (no ACAO header emitted)', () => {
		expect(resolveCorsOrigin('https://attacker.example')).toBe(null)
	})

	test('[C3] empty string origin → null', () => {
		expect(resolveCorsOrigin('')).toBe(null)
	})

	test('[C4] case-mismatch → null (CORS canon is case-sensitive exact match)', () => {
		const allowed = corsAllowlist[0]
		if (allowed) {
			// Uppercase the URL — should NOT match (browsers send lowercase URLs).
			expect(resolveCorsOrigin(allowed.toUpperCase())).toBe(null)
		}
	})

	test('[C5] trailing-slash variant → null (no normalization)', () => {
		const allowed = corsAllowlist[0]
		if (allowed) {
			expect(resolveCorsOrigin(`${allowed}/`)).toBe(null)
		}
	})

	test('[C6] subdomain spoof → null', () => {
		// Attacker controls evil.demo.sepshn.ru subdomain — must NOT inherit trust.
		expect(resolveCorsOrigin('https://evil.demo.sepshn.ru')).toBe(null)
	})

	test('[C7] http→https scheme spoof → null', () => {
		const allowed = corsAllowlist[0]
		if (allowed && allowed.startsWith('https://')) {
			const insecure = allowed.replace(/^https:/, 'http:')
			expect(resolveCorsOrigin(insecure)).toBe(null)
		}
	})
})
