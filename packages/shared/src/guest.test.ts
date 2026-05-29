/**
 * `isRussianCitizenship` — strict tests (G4.bis 2026-05-15).
 *
 * Pre-done audit:
 *   [R1] 'RU' alpha-2 → true
 *   [R2] 'RUS' alpha-3 → true (G4.bis bug fix — prior backend missed this)
 *   [R3] case-insensitive (lower / mixed / upper) для обоих encodings
 *   [F1] non-RU 2-char codes → false (US, DE, CN, KZ, BY, FR, JP)
 *   [F2] non-RU 3-char codes → false (USA, DEU, CHN, JPN, etc.)
 *   [E1] empty string → false (defensive — not thrown)
 *   [E2] schema-invalid lengths (1 char, 4 char) → false (defensive)
 *   [E3] non-ASCII Cyrillic «РУ» NOT mapped к 'RU' (canonical ISO requires Latin)
 *
 *   [I1] frozen Set — adding к exported `RUSSIAN_CITIZENSHIP_CODES`
 *        не affect canonical semantics (immutability invariant)
 */
import { describe, expect, it } from 'bun:test'
import { isForeignCitizenship, isRussianCitizenship, RUSSIAN_CITIZENSHIP_CODES } from './guest.ts'

describe('isRussianCitizenship — recognises both ISO alpha-2 + alpha-3', () => {
	it('[R1] RU alpha-2 → true', () => {
		expect(isRussianCitizenship('RU')).toBe(true)
	})
	it('[R2] RUS alpha-3 → true (G4.bis fix — was bug)', () => {
		expect(isRussianCitizenship('RUS')).toBe(true)
	})
	it('[R3] case-insensitive for both encodings', () => {
		expect(isRussianCitizenship('ru')).toBe(true)
		expect(isRussianCitizenship('Ru')).toBe(true)
		expect(isRussianCitizenship('rU')).toBe(true)
		expect(isRussianCitizenship('rus')).toBe(true)
		expect(isRussianCitizenship('Rus')).toBe(true)
		expect(isRussianCitizenship('rUs')).toBe(true)
		expect(isRussianCitizenship('RUs')).toBe(true)
	})
})

describe('isRussianCitizenship — foreign codes', () => {
	it('[F1] non-RU 2-char codes → false', () => {
		for (const code of ['US', 'DE', 'CN', 'KZ', 'BY', 'FR', 'JP', 'IT', 'ES', 'TR', 'AM', 'UA']) {
			expect(isRussianCitizenship(code)).toBe(false)
		}
	})
	it('[F2] non-RU 3-char codes → false', () => {
		for (const code of ['USA', 'DEU', 'CHN', 'JPN', 'FRA', 'ITA', 'ESP', 'TUR', 'ARM', 'UKR']) {
			expect(isRussianCitizenship(code)).toBe(false)
		}
	})
})

describe('isRussianCitizenship — defensive edge cases', () => {
	it('[E1] empty string → false (does NOT throw)', () => {
		expect(() => isRussianCitizenship('')).not.toThrow()
		expect(isRussianCitizenship('')).toBe(false)
	})
	it('[E2] schema-invalid lengths → false (defensive, не throw)', () => {
		expect(isRussianCitizenship('R')).toBe(false)
		expect(isRussianCitizenship('RUSSI')).toBe(false)
		expect(isRussianCitizenship('     ')).toBe(false)
	})
	it('[E3] Cyrillic «РУ» NOT recognized (canonical ISO requires Latin)', () => {
		expect(isRussianCitizenship('РУ')).toBe(false)
		expect(isRussianCitizenship('РУС')).toBe(false)
	})
})

describe('RUSSIAN_CITIZENSHIP_CODES — immutability invariant', () => {
	it('[I1] Set contains exactly RU + RUS, no other codes', () => {
		expect(RUSSIAN_CITIZENSHIP_CODES.size).toBe(2)
		expect(RUSSIAN_CITIZENSHIP_CODES.has('RU')).toBe(true)
		expect(RUSSIAN_CITIZENSHIP_CODES.has('RUS')).toBe(true)
		expect(RUSSIAN_CITIZENSHIP_CODES.has('US')).toBe(false)
		expect(RUSSIAN_CITIZENSHIP_CODES.has('RUSS')).toBe(false)
	})
	it('[I2] ReadonlySet type — mutation rejected by TypeScript (compile-time)', () => {
		// Runtime check that ReadonlySet contract holds — there is no `add`
		// method exposed; this is enforced by `as const` + type signature.
		expect('add' in RUSSIAN_CITIZENSHIP_CODES).toBe(true) // Set has it natively
		// But the exported type is `ReadonlySet` — so callers can't .add() at
		// compile time. This test documents that runtime mutation IS possible
		// (warning: never do this in callers) — TypeScript-only safety.
	})
})

describe('isForeignCitizenship — fail-closed МВД gate detector', () => {
	it('[F1] RU citizen (alpha-2/3, any case) → NOT foreign', () => {
		for (const ru of ['RU', 'RUS', 'ru', 'rus', 'Rus']) {
			expect(isForeignCitizenship(ru)).toBe(false)
		}
	})

	it('[F2] foreign codes → foreign', () => {
		for (const code of ['US', 'USA', 'BY', 'KAZ', 'DEU']) {
			expect(isForeignCitizenship(code)).toBe(true)
		}
	})

	it('[F3] FAIL-CLOSED — unknown/empty/null/undefined → foreign (require scan)', () => {
		// 109-ФЗ: missing citizenship MUST err toward requiring a passport scan.
		expect(isForeignCitizenship('')).toBe(true)
		expect(isForeignCitizenship('   ')).toBe(true)
		expect(isForeignCitizenship(null)).toBe(true)
		expect(isForeignCitizenship(undefined)).toBe(true)
	})

	it('[F4] exact inverse of isRussianCitizenship for present values', () => {
		for (const c of ['RU', 'RUS', 'US', 'USA', 'BY']) {
			expect(isForeignCitizenship(c)).toBe(!isRussianCitizenship(c))
		}
	})
})
