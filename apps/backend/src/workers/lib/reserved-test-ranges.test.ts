/**
 * `reserved-test-ranges` — strict tests для shared outbound-shield predicates.
 *
 * Pre-done audit matrix:
 *   ─── isReservedTestDomain (RFC 2606 §3 + §2 + RFC 6761) ──────────────
 *     [D1]  user@example.com → true
 *     [D2]  user@example.net → true
 *     [D3]  user@example.org → true
 *     [D4]  user@foo.test → true (TLD)
 *     [D5]  user@deep.subdomain.test → true (nested TLD)
 *     [D6]  user@foo.invalid → true
 *     [D7]  user@foo.example → true
 *     [D8]  user@app.localhost → true
 *     [D9]  user@localhost → true (bare reserved TLD)
 *     [D10] user@gmail.com / @yandex.ru / @sepshn.ru → false (real)
 *     [D11] user@example-llc.com → false (substring trap)
 *     [D12] user@notexample.com → false (substring trap)
 *     [D13] user@testing.com / user@invalidate.com → false (substring trap)
 *     [D14] no @-sign / empty → false (defensive)
 *     [D15] case-insensitive + trim
 *
 *   ─── isReservedTestPhone (ITU-T E.164.3 §6.1 + NANP + RU-Россвязь) ───
 *     [P1]  +99899XXXXXXX (ITU test prefix) → true
 *     [P2]  +1 (212) 555-0100 (NANP test block) → true
 *     [P3]  +1 (415) 555-0199 (NANP test block boundary) → true
 *     [P4]  +7 000 XXX XXXX (RU Россвязь reserved) → true
 *     [P5]  +7 900 XXX XXXX (real RU mobile, не reserved) → false
 *     [P6]  +1 (212) 555-0200 (вне NANP test 01XX block) → false
 *     [P7]  +1 (212) 555-1234 (NXX вне 555-01XX) → false
 *     [P8]  whitespace/hyphen/paren tolerance
 *     [P9]  no leading + (raw E.164) — same result
 *     [P10] empty / garbage → false (defensive)
 */
import { describe, expect, it } from 'bun:test'
import { isReservedTestDomain, isReservedTestPhone } from './reserved-test-ranges.ts'

describe('isReservedTestDomain — RFC 2606 + RFC 6761', () => {
	it('[D1] user@example.com → true', () => {
		expect(isReservedTestDomain('user@example.com')).toBe(true)
	})

	it('[D2] user@example.net → true', () => {
		expect(isReservedTestDomain('user@example.net')).toBe(true)
	})

	it('[D3] user@example.org → true', () => {
		expect(isReservedTestDomain('user@example.org')).toBe(true)
	})

	it('[D4] user@foo.test → true (.test reserved TLD)', () => {
		expect(isReservedTestDomain('integration@foo.test')).toBe(true)
	})

	it('[D5] user@deep.subdomain.test → true (nested под TLD)', () => {
		expect(isReservedTestDomain('user@a.b.c.test')).toBe(true)
	})

	it('[D6] user@foo.invalid → true', () => {
		expect(isReservedTestDomain('user@foo.invalid')).toBe(true)
	})

	it('[D7] user@foo.example → true', () => {
		expect(isReservedTestDomain('user@foo.example')).toBe(true)
	})

	it('[D8] user@app.localhost → true', () => {
		expect(isReservedTestDomain('user@app.localhost')).toBe(true)
	})

	it('[D9] user@localhost (bare TLD) → true', () => {
		expect(isReservedTestDomain('user@localhost')).toBe(true)
	})

	it('[D10] real domains → false', () => {
		expect(isReservedTestDomain('user@gmail.com')).toBe(false)
		expect(isReservedTestDomain('user@yandex.ru')).toBe(false)
		expect(isReservedTestDomain('user@sepshn.ru')).toBe(false)
		expect(isReservedTestDomain('user@mail.ru')).toBe(false)
	})

	it('[D11] substring trap — example-llc.com', () => {
		expect(isReservedTestDomain('user@example-llc.com')).toBe(false)
	})

	it('[D12] substring trap — notexample.com', () => {
		expect(isReservedTestDomain('user@notexample.com')).toBe(false)
	})

	it('[D13] substring trap — testing.com / invalidate.com', () => {
		expect(isReservedTestDomain('user@testing.com')).toBe(false)
		expect(isReservedTestDomain('user@invalidate.com')).toBe(false)
	})

	it('[D14] malformed → false', () => {
		expect(isReservedTestDomain('not-an-email')).toBe(false)
		expect(isReservedTestDomain('')).toBe(false)
		expect(isReservedTestDomain('@')).toBe(false)
	})

	it('[D15] case-insensitive + trim', () => {
		expect(isReservedTestDomain('  User@EXAMPLE.COM  ')).toBe(true)
		expect(isReservedTestDomain('USER@FOO.TEST')).toBe(true)
	})
})

describe('isReservedTestPhone — ITU-T E.164.3 + national plans', () => {
	it('[P1] +99899XXXXXXX (ITU-T E.164.3 §6.1) → true', () => {
		expect(isReservedTestPhone('+998991234567')).toBe(true)
		expect(isReservedTestPhone('+99899012345678')).toBe(true)
	})

	it('[P2] +1 (212) 555-0100 (NANP test block) → true', () => {
		expect(isReservedTestPhone('+12125550100')).toBe(true)
	})

	it('[P3] +1 (415) 555-0199 (NANP test boundary) → true', () => {
		expect(isReservedTestPhone('+14155550199')).toBe(true)
	})

	it('[P4] +7 000 XXX XXXX (RU Россвязь reserved) → true', () => {
		expect(isReservedTestPhone('+70001234567')).toBe(true)
		expect(isReservedTestPhone('+70009999999')).toBe(true)
	})

	it('[P5] +7 900 XXX XXXX (real RU mobile) → false', () => {
		expect(isReservedTestPhone('+79001234567')).toBe(false)
	})

	it('[P6] +1 (212) 555-0200 (за NANP 01XX) → false', () => {
		expect(isReservedTestPhone('+12125550200')).toBe(false)
	})

	it('[P7] +1 (212) 555-1234 (NXX вне 555-01XX) → false', () => {
		expect(isReservedTestPhone('+12125551234')).toBe(false)
	})

	it('[P8] whitespace / hyphen / paren tolerance', () => {
		expect(isReservedTestPhone('+1 (212) 555-0100')).toBe(true)
		expect(isReservedTestPhone('+7 000 123 4567')).toBe(true)
		expect(isReservedTestPhone('+998-99-123-45-67')).toBe(true)
	})

	it('[P9] no leading + (raw digits) — same result', () => {
		expect(isReservedTestPhone('12125550100')).toBe(true)
		expect(isReservedTestPhone('70001234567')).toBe(true)
	})

	it('[P10] empty / garbage → false (defensive)', () => {
		expect(isReservedTestPhone('')).toBe(false)
		expect(isReservedTestPhone('+')).toBe(false)
		expect(isReservedTestPhone('abc')).toBe(false)
		expect(isReservedTestPhone('++++')).toBe(false)
	})
})
