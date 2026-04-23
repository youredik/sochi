import { describe, expect, it } from 'vitest'
import { slugify } from './slugify.ts'

/**
 * Strict tests for slugify — hunt bugs, exact-value asserts, adversarial
 * inputs. Pure function, so table-driven with concrete expected strings.
 *
 * Invariants:
 *   1. Cyrillic → Latin transliteration is byte-stable (no locale drift)
 *   2. Output matches `/^[a-z0-9-]*$/` (no URL-breaking chars)
 *   3. No leading/trailing hyphens
 *   4. Max length 48 (enforced)
 *   5. Empty / noise-only input returns empty string (caller decides fallback)
 */
describe('slugify', () => {
	describe('Cyrillic transliteration (exact-value)', () => {
		it.each([
			['Гостиница Ромашка', 'gostinica-romashka'],
			['Отель', 'otel'],
			['Красная Поляна', 'krasnaya-polyana'],
			['Имеретинская низменность', 'imeretinskaya-nizmennost'],
			['Ёжик', 'yozhik'],
			['Щенок', 'shhenok'],
		])('transliterates %s → %s', (input, expected) => {
			expect(slugify(input)).toBe(expected)
		})
	})

	describe('Latin pass-through (exact-value)', () => {
		it.each([
			['Horeca Suites', 'horeca-suites'],
			['MY-HOTEL_2026', 'my-hotel-2026'],
			['simple', 'simple'],
		])('passes %s → %s', (input, expected) => {
			expect(slugify(input)).toBe(expected)
		})
	})

	describe('adversarial inputs (negative paths)', () => {
		it('returns empty for emoji-only input', () => {
			expect(slugify('🏨🌊')).toBe('')
		})

		it('returns empty for whitespace-only input', () => {
			expect(slugify('   \t\n  ')).toBe('')
		})

		it('returns empty for empty string', () => {
			expect(slugify('')).toBe('')
		})

		it('neutralises SQL-injection-looking input', () => {
			// Apostrophe / semicolon / dashes become safe slug chars
			const out = slugify("admin'; DROP TABLE users--")
			expect(out).toBe('admin-drop-table-users')
			expect(out).not.toContain("'")
			expect(out).not.toContain(';')
		})

		it('neutralises path-traversal-looking input', () => {
			expect(slugify('../../etc/passwd')).toBe('etc-passwd')
		})

		it('collapses consecutive spaces and dashes', () => {
			expect(slugify('foo   ---   bar')).toBe('foo-bar')
		})

		it('strips leading/trailing hyphens', () => {
			expect(slugify('---horeca---')).toBe('horeca')
		})

		it('strips leading/trailing whitespace', () => {
			expect(slugify('  Ромашка  ')).toBe('romashka')
		})
	})

	describe('length cap (immutable)', () => {
		it('caps at 48 characters', () => {
			const long = 'a'.repeat(200)
			expect(slugify(long)).toHaveLength(48)
		})

		it('caps a Cyrillic string that blows past 48 chars after transliteration', () => {
			// "щ" → "shh" triples length; 20 chars of щ becomes 60 chars — caps to 48
			const out = slugify('щ'.repeat(20))
			expect(out).toHaveLength(48)
			expect(out).toMatch(/^shh/)
		})
	})

	describe('output invariants (universal)', () => {
		it.each([
			'Гостиница',
			'Mixed123 слов',
			"admin'; drop--",
			'foo---bar',
			'  leading trailing  ',
		])('%s → output matches /^[a-z0-9-]*$/ and has no leading/trailing hyphens', (input) => {
			const out = slugify(input)
			expect(out).toMatch(/^[a-z0-9-]*$/)
			expect(out).not.toMatch(/^-/)
			expect(out).not.toMatch(/-$/)
		})
	})
})
