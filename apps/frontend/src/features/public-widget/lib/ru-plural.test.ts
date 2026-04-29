/**
 * `ruPlural` — strict tests per `feedback_strict_tests.md`.
 *
 * Test matrix follows CLDR three-form Russian pluralization rules:
 *   - one (mod10=1, NOT mod100=11)
 *   - few (mod10 in 2..4, NOT mod100 in 12..14)
 *   - many (everything else, including 0 + 11..14 special-case)
 *
 * Adversarial focus: 11..14 + 111..114 mod100 propagation (canon trap).
 */
import { describe, expect, test } from 'vitest'
import { ruPlural } from './ru-plural.ts'

describe('ruPlural — pure function (RU CLDR three-form: one/few/many)', () => {
	const obj = (n: number) => ruPlural(n, 'объект', 'объекта', 'объектов')

	// ─── one (mod10=1, NOT mod100=11) ──────────────────────────────
	test('[RU1] 1 → «объект»', () => expect(obj(1)).toBe('объект'))
	test('[RU2] 21 → «объект»', () => expect(obj(21)).toBe('объект'))
	test('[RU3] 101 → «объект»', () => expect(obj(101)).toBe('объект'))
	test('[RU4] 1001 → «объект»', () => expect(obj(1001)).toBe('объект'))

	// ─── few (mod10 in 2..4, NOT mod100 in 12..14) ─────────────────
	test('[RU5] 2 → «объекта»', () => expect(obj(2)).toBe('объекта'))
	test('[RU6] 3 → «объекта»', () => expect(obj(3)).toBe('объекта'))
	test('[RU7] 4 → «объекта»', () => expect(obj(4)).toBe('объекта'))
	test('[RU8] 22 → «объекта»', () => expect(obj(22)).toBe('объекта'))
	test('[RU9] 33 → «объекта»', () => expect(obj(33)).toBe('объекта'))
	test('[RU10] 104 → «объекта»', () => expect(obj(104)).toBe('объекта'))

	// ─── many (everything else) ────────────────────────────────────
	test('[RU11] 0 → «объектов»', () => expect(obj(0)).toBe('объектов'))
	test('[RU12] 5 → «объектов»', () => expect(obj(5)).toBe('объектов'))
	test('[RU13] 9 → «объектов»', () => expect(obj(9)).toBe('объектов'))
	test('[RU14] 10 → «объектов»', () => expect(obj(10)).toBe('объектов'))

	// ─── Adversarial: 11..14 special-case (always many despite mod10) ────
	test('[RU15] 11 → «объектов» (NOT объект, despite mod10=1)', () =>
		expect(obj(11)).toBe('объектов'))
	test('[RU16] 12 → «объектов» (NOT объекта, despite mod10=2)', () =>
		expect(obj(12)).toBe('объектов'))
	test('[RU17] 13 → «объектов» (NOT объекта, despite mod10=3)', () =>
		expect(obj(13)).toBe('объектов'))
	test('[RU18] 14 → «объектов» (NOT объекта, despite mod10=4)', () =>
		expect(obj(14)).toBe('объектов'))

	// ─── Adversarial: 111..114 also special-case (mod100 in 11..14) ──────
	test('[RU19] 111 → «объектов» (mod100=11 still special)', () => expect(obj(111)).toBe('объектов'))
	test('[RU20] 113 → «объектов» (mod100=13 still special)', () => expect(obj(113)).toBe('объектов'))

	// ─── Adversarial: 100, 105, 200 (basic many) ───────────────────────
	test('[RU21] 100 → «объектов»', () => expect(obj(100)).toBe('объектов'))
	test('[RU22] 105 → «объектов»', () => expect(obj(105)).toBe('объектов'))
	test('[RU23] 200 → «объектов»', () => expect(obj(200)).toBe('объектов'))

	// ─── Adversarial: 121, 122 (mod100=21, 22 — falls through to mod10 rule) ──
	test('[RU24] 121 → «объект» (mod10=1, mod100=21 NOT in 11..14)', () =>
		expect(obj(121)).toBe('объект'))
	test('[RU25] 122 → «объекта» (mod10=2, mod100=22 NOT in 11..14)', () =>
		expect(obj(122)).toBe('объекта'))
})
