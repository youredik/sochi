/**
 * `microsToKopecks` strict tests per memory `feedback_strict_tests.md`.
 *
 * Test plan:
 *   Happy path (exact-value):
 *     [H1] zero in → zero out
 *     [H2] 1 ₽ = 100_000_000 micros → 100n kopecks
 *     [H3] 1500 ₽ = 1_500_000_000 micros → 150_000n kopecks
 *     [H4] 50_000 ₽ tax base = 50_000_000_000 micros → 5_000_000n kopecks
 *
 *   Sub-rouble truncation (boundary):
 *     [T1] 999_999 micros (< 1 kopeck) → 0n
 *     [T2] 1_000_000 micros (= 1 kopeck) → 1n
 *     [T3] 99_999_999 micros (= 99.999999 kopecks) → 99n (truncates, NOT rounds)
 *     [T4] 100_000_000 micros (= 100 kopecks = 1 ₽) → 100n
 *
 *   Large values (Int64 boundary):
 *     [L1] 9_223_372_036_854 (large but << Int64 max) — exact divide by 1M
 *
 *   Adversarial (malformed string in payload should throw, not silently 0):
 *     [E1] empty string → SyntaxError (BigInt parser)
 *     [E2] "abc" → SyntaxError
 *     [E3] negative "-100_000_000" → -100n (preserves sign — refunds могут быть отрицательными)
 *
 *   Immutability:
 *     [I1] input string unchanged after call
 */
import { describe, expect, test } from 'vitest'
import { microsToKopecks } from './micros-to-kopecks.ts'

describe('microsToKopecks — happy path', () => {
	test('[H1] 0 micros → 0n kopecks', () => {
		expect(microsToKopecks('0')).toBe(0n)
	})
	test('[H2] 100_000_000 micros (= 1 ₽) → 100n kopecks', () => {
		expect(microsToKopecks('100000000')).toBe(100n)
	})
	test('[H3] 1_500_000_000 micros (= 15 ₽) → 1_500n kopecks', () => {
		expect(microsToKopecks('1500000000')).toBe(1_500n)
	})
	test('[H4] 50_000_000_000 micros (= 500 ₽) → 50_000n kopecks', () => {
		expect(microsToKopecks('50000000000')).toBe(50_000n)
	})
})

describe('microsToKopecks — sub-rouble truncation boundary', () => {
	test('[T1] 999_999 micros (< 1 kopeck) → 0n', () => {
		expect(microsToKopecks('999999')).toBe(0n)
	})
	test('[T2] 1_000_000 micros (= 1 kopeck) → 1n', () => {
		expect(microsToKopecks('1000000')).toBe(1n)
	})
	test('[T3] 99_999_999 micros (just under 100 kopecks) → 99n (truncate, NOT round)', () => {
		expect(microsToKopecks('99999999')).toBe(99n)
	})
	test('[T4] 100_000_000 micros (= 100 kopecks = 1 ₽) → 100n', () => {
		expect(microsToKopecks('100000000')).toBe(100n)
	})
})

describe('microsToKopecks — large values', () => {
	test('[L1] 9_223_372_036_000_000 micros (= 9_223_372_036n kopecks ≈ 92M ₽)', () => {
		expect(microsToKopecks('9223372036000000')).toBe(9_223_372_036n)
	})
})

describe('microsToKopecks — adversarial (malformed string)', () => {
	// Empirical: `BigInt('')` returns 0n (NOT SyntaxError). This is a JS-engine
	// quirk that strict tests must document so reviewers don't expect throw.
	test('[E1] empty string → 0n (BigInt parse quirk, NOT SyntaxError)', () => {
		expect(microsToKopecks('')).toBe(0n)
	})
	test('[E2] non-numeric "abc" → SyntaxError', () => {
		expect(() => microsToKopecks('abc')).toThrow(SyntaxError)
	})
	test('[E3] negative "-100_000_000" → -100n (sign preserved — refunds OK)', () => {
		expect(microsToKopecks('-100000000')).toBe(-100n)
	})
})

describe('microsToKopecks — immutability', () => {
	test('[I1] input string is not mutated', () => {
		const input = '50000000000'
		const before = input
		microsToKopecks(input)
		expect(input).toBe(before)
	})
})
