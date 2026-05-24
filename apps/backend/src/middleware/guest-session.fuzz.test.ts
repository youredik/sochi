/**
 * Property-based fuzz tests на `parseCookiePayload` — Sprint C+ Round 6
 * Security red team P2 closure 2026-05-24.
 *
 * Surface under test: `guest-session.ts:parseCookiePayload(raw)` parses a
 * JSON-shaped cookie payload и returns canonical `GuestSession | null`.
 *
 * Threat model fuzz:
 *   - Arbitrary malformed JSON strings → never throws, returns null
 *   - JSON parsing arbitrary types (numbers, arrays, nested objects) → null
 *   - JSON с extra/missing/typo-shaped properties → null
 *   - Embedded `.` characters в values (the lastIndexOf split worry — fuzz
 *     proves parser robust to dot smuggling regardless of split point)
 *   - Unicode edge cases (BOM, surrogate halves, RTL embedding, U+2028)
 *   - Whitespace + control character payloads
 *
 * Invariants:
 *   [I1] never throws (must return either valid GuestSession OR null)
 *   [I2] if returns non-null, all 4 fields are present + match canonical
 *        scope enum ('view'|'mutate')
 *   [I3] no prototype pollution — `__proto__`/`constructor`/`prototype`
 *        keys in input do NOT contaminate returned object's prototype
 */
import { describe, expect, test } from 'bun:test'
import * as fc from 'fast-check'
import { __testGuestSessionInternals } from './guest-session.ts'

const { parseCookiePayload } = __testGuestSessionInternals

describe('parseCookiePayload — property-based fuzz', () => {
	test('[I1] never throws on arbitrary JSON string input', () => {
		void fc.assert(
			fc.property(fc.string(), (raw) => {
				expect(() => parseCookiePayload(raw)).not.toThrow()
			}),
			{ numRuns: 500 },
		)
	})

	test('[I1.json] never throws on stringified arbitrary JSON value', () => {
		void fc.assert(
			fc.property(fc.jsonValue(), (val) => {
				expect(() => parseCookiePayload(JSON.stringify(val))).not.toThrow()
			}),
			{ numRuns: 500 },
		)
	})

	test('[I1.dots] never throws on inputs containing dot-smuggle patterns', () => {
		// Adversarial: payload values containing `.` could confuse upstream
		// lastIndexOf split — verify parser handles them robustly.
		void fc.assert(
			fc.property(
				fc.string({ unit: fc.string({ minLength: 0, maxLength: 5 }) }).map((s) => s),
				(s) => {
					// Embed dots в potentially-valid JSON structure
					const wrapped = `{"t":".${s}.","b":".${s}","s":"view","j":"${s}.."}`
					expect(() => parseCookiePayload(wrapped)).not.toThrow()
				},
			),
			{ numRuns: 500 },
		)
	})

	test('[I1.binary] never throws on raw byte sequences (treated as UTF-8)', () => {
		void fc.assert(
			fc.property(fc.string({ unit: 'binary' }), (raw) => {
				expect(() => parseCookiePayload(raw)).not.toThrow()
			}),
			{ numRuns: 300 },
		)
	})

	test('[I2] valid-shaped payload returns canonical GuestSession', () => {
		void fc.assert(
			fc.property(
				fc.record({
					t: fc.string({ minLength: 1, maxLength: 50 }),
					b: fc.string({ minLength: 1, maxLength: 50 }),
					j: fc.string({ minLength: 1, maxLength: 50 }),
					s: fc.constantFrom('view', 'mutate'),
				}),
				(obj) => {
					const result = parseCookiePayload(JSON.stringify(obj))
					expect(result).toEqual({
						tenantId: obj.t,
						bookingId: obj.b,
						scope: obj.s,
						jti: obj.j,
					})
				},
			),
			{ numRuns: 300 },
		)
	})

	test('[I2.invalid] missing or wrong-typed field returns null', () => {
		// Generates objects missing one required field или с non-string value.
		void fc.assert(
			fc.property(
				fc.record({
					t: fc.option(fc.string()),
					b: fc.option(fc.string()),
					j: fc.option(fc.string()),
					s: fc.option(fc.constantFrom('view', 'mutate', 'admin', '')),
				}),
				(obj) => {
					const result = parseCookiePayload(JSON.stringify(obj))
					// Result is non-null iff all 4 required types correct.
					const allValid =
						typeof obj.t === 'string' &&
						typeof obj.b === 'string' &&
						typeof obj.j === 'string' &&
						(obj.s === 'view' || obj.s === 'mutate')
					if (allValid) {
						expect(result).not.toBeNull()
					} else {
						expect(result).toBeNull()
					}
				},
			),
			{ numRuns: 300 },
		)
	})

	test('[I3] no prototype pollution via __proto__/constructor/prototype keys', () => {
		// Adversarial: JSON.parse handles __proto__ as own property (not prototype
		// assignment) since ES2017; but verify return object is clean dict.
		const polluted = JSON.stringify({
			t: 'tenant',
			b: 'booking',
			j: 'jwt',
			s: 'view',
			__proto__: { hacked: true },
			constructor: { hacked: true },
			prototype: { hacked: true },
		})
		const result = parseCookiePayload(polluted) as Record<string, unknown> | null
		expect(result).not.toBeNull()
		// Object.prototype unaffected
		expect(({} as Record<string, unknown>).hacked).toBeUndefined()
		// Returned object has no leaked own keys from __proto__ pollution attempt
		if (result) {
			expect(Object.keys(result).sort()).toEqual(['bookingId', 'jti', 'scope', 'tenantId'])
		}
	})

	test('[I3.canonical] returned object has clean shape — only 4 canonical keys', () => {
		void fc.assert(
			fc.property(
				fc.record({
					t: fc.string({ minLength: 1 }),
					b: fc.string({ minLength: 1 }),
					j: fc.string({ minLength: 1 }),
					s: fc.constantFrom('view', 'mutate'),
					// Adversarial extra keys ignored
					extra: fc.string(),
					proto: fc.string(),
				}),
				(obj) => {
					const result = parseCookiePayload(JSON.stringify(obj)) as Record<string, unknown> | null
					expect(result).not.toBeNull()
					if (result) {
						expect(Object.keys(result).sort()).toEqual(['bookingId', 'jti', 'scope', 'tenantId'])
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	test('[E1] empty string returns null (regression)', () => {
		expect(parseCookiePayload('')).toBeNull()
	})

	test('[E2] non-JSON returns null (regression)', () => {
		expect(parseCookiePayload('not json')).toBeNull()
		expect(parseCookiePayload('{broken')).toBeNull()
		expect(parseCookiePayload('[]')).toBeNull()
		expect(parseCookiePayload('null')).toBeNull()
		expect(parseCookiePayload('"string-only"')).toBeNull()
		expect(parseCookiePayload('42')).toBeNull()
	})

	test('[E3] valid canonical payload (regression)', () => {
		const payload = JSON.stringify({ t: 'org_x', b: 'bkg_y', j: 'jti_z', s: 'view' })
		expect(parseCookiePayload(payload)).toEqual({
			tenantId: 'org_x',
			bookingId: 'bkg_y',
			scope: 'view',
			jti: 'jti_z',
		})
	})
})
