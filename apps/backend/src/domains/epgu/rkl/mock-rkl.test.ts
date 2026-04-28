/**
 * MockRklCheck — strict tests per `feedback_strict_tests.md`.
 *
 * Test matrix:
 *   ─── Construction ───────────────────────────────────────────────
 *     [C1] source = 'mock_rkl'
 *
 *   ─── forceStatus override ────────────────────────────────────────
 *     [F1] forceStatus='clean' → status=clean, matchType=null
 *     [F2] forceStatus='match' → status=match, matchType='exact'
 *     [F3] forceStatus='inconclusive' → status=inconclusive, matchType='partial'
 *
 *   ─── Distribution (1000 trials per canonical 99/0.5/0.5) ─────────
 *     [D1] clean ≈ 99% (count > 950)
 *     [D2] match + inconclusive together ≈ 1% (count > 5, < 50)
 *
 *   ─── Latency in 50-300 ms range ──────────────────────────────────
 *     [L1] all latencies ∈ [50, 300]
 *
 *   ─── registryRevision format ─────────────────────────────────────
 *     [R1] format YYYY-MM-DD.NNN (date + 3-digit counter)
 *     [R2] same day → same date prefix, counter increments
 *
 *   ─── rawResponseJson contract ────────────────────────────────────
 *     [Raw1] contains status, checked_at, registry_revision
 *     [Raw2] match_type only when status != clean
 */
import { describe, expect, test } from 'vitest'
import { createMockRklCheck } from './mock-rkl.ts'

function makeRng(seed: number): () => number {
	let s = seed
	return () => {
		s = (s + 0x6d2b79f5) | 0
		let t = s
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const CHECK_REQ = {
	documentType: 'passport_ru' as const,
	series: '4608',
	number: '123456',
	birthdate: '1985-05-15',
}

describe('MockRklCheck — construction', () => {
	test('[C1] source = "mock_rkl"', () => {
		expect(createMockRklCheck().source).toBe('mock_rkl')
	})
})

describe('MockRklCheck — forceStatus override', () => {
	test('[F1] forceStatus=clean → status=clean, matchType=null', async () => {
		const m = createMockRklCheck({ random: makeRng(1), forceStatus: 'clean' })
		const r = await m.check(CHECK_REQ)
		expect(r.status).toBe('clean')
		expect(r.matchType).toBeNull()
	})

	test('[F2] forceStatus=match → status=match, matchType=exact', async () => {
		const m = createMockRklCheck({ random: makeRng(2), forceStatus: 'match' })
		const r = await m.check(CHECK_REQ)
		expect(r.status).toBe('match')
		expect(r.matchType).toBe('exact')
	})

	test('[F3] forceStatus=inconclusive → status=inconclusive, matchType=partial', async () => {
		const m = createMockRklCheck({ random: makeRng(3), forceStatus: 'inconclusive' })
		const r = await m.check(CHECK_REQ)
		expect(r.status).toBe('inconclusive')
		expect(r.matchType).toBe('partial')
	})
})

describe('MockRklCheck — distribution (1000 trials)', () => {
	test('[D1] clean ≈ 99% + [D2] match+inconclusive ≈ 1%', async () => {
		let cleanCount = 0
		let matchCount = 0
		let inconclusiveCount = 0
		for (let i = 0; i < 1000; i++) {
			const m = createMockRklCheck({ random: makeRng(i + 10000) })
			const r = await m.check(CHECK_REQ)
			if (r.status === 'clean') cleanCount += 1
			else if (r.status === 'match') matchCount += 1
			else inconclusiveCount += 1
		}
		// Canonical 99/0.5/0.5 — wide tolerance for stochastic test stability
		expect(cleanCount).toBeGreaterThan(950) // >95%
		expect(cleanCount).toBeLessThan(1000) // some non-clean expected
		expect(matchCount + inconclusiveCount).toBeGreaterThan(0)
		expect(matchCount + inconclusiveCount).toBeLessThan(50) // < 5%
	})
})

describe('MockRklCheck — latency', () => {
	test('[L1] all latencies ∈ [50, 300]', async () => {
		for (let i = 0; i < 100; i++) {
			const m = createMockRklCheck({ random: makeRng(i + 20000) })
			const r = await m.check(CHECK_REQ)
			expect(r.latencyMs).toBeGreaterThanOrEqual(50)
			expect(r.latencyMs).toBeLessThanOrEqual(300)
		}
	})
})

describe('MockRklCheck — registryRevision format', () => {
	test('[R1] format YYYY-MM-DD.NNN', async () => {
		const m = createMockRklCheck({ random: makeRng(1), now: () => Date.UTC(2026, 3, 28) })
		const r = await m.check(CHECK_REQ)
		expect(r.registryRevision).toMatch(/^\d{4}-\d{2}-\d{2}\.\d{3}$/)
	})

	test('[R2] same day → same prefix + incrementing counter', async () => {
		const m = createMockRklCheck({ random: makeRng(1), now: () => Date.UTC(2026, 3, 28) })
		const r1 = await m.check(CHECK_REQ)
		const r2 = await m.check(CHECK_REQ)
		const r3 = await m.check(CHECK_REQ)
		expect(r1.registryRevision.slice(0, 10)).toBe(r2.registryRevision.slice(0, 10))
		expect(r1.registryRevision.slice(0, 10)).toBe(r3.registryRevision.slice(0, 10))
		const c1 = parseInt(r1.registryRevision.slice(11), 10)
		const c2 = parseInt(r2.registryRevision.slice(11), 10)
		const c3 = parseInt(r3.registryRevision.slice(11), 10)
		expect(c2).toBe(c1 + 1)
		expect(c3).toBe(c2 + 1)
	})
})

describe('MockRklCheck — rawResponseJson', () => {
	test('[Raw1] contains status, checked_at, registry_revision', async () => {
		const m = createMockRklCheck({ random: makeRng(1) })
		const r = await m.check(CHECK_REQ)
		expect(r.rawResponseJson).toHaveProperty('status')
		expect(r.rawResponseJson).toHaveProperty('checked_at')
		expect(r.rawResponseJson).toHaveProperty('registry_revision')
	})

	test('[Raw2] match_type only when status != clean', async () => {
		const mClean = createMockRklCheck({ random: makeRng(1), forceStatus: 'clean' })
		const mMatch = createMockRklCheck({ random: makeRng(2), forceStatus: 'match' })
		const rClean = await mClean.check(CHECK_REQ)
		const rMatch = await mMatch.check(CHECK_REQ)
		expect(rClean.rawResponseJson).not.toHaveProperty('match_type')
		expect(rMatch.rawResponseJson).toHaveProperty('match_type', 'exact')
	})
})
