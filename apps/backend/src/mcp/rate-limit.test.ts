/**
 * Round 14 self-review #4 — tests для MCP rate-limit module.
 *
 * Self-review #3 audit found ZERO tests на the cost-runaway-defense module.
 * The previous implementation (hono-rate-limiter wrapped в an async middleware-
 * capture helper) was empirically BYPASSED: 12 calls returned 200, AI tool fired
 * regardless of bucket state. The new implementation uses an explicit in-memory
 * bucket с direct return — tested here.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { __resetAiBucket, AI_LIMIT, AI_WINDOW_MS, checkAiRateLimit } from './rate-limit.ts'

describe('MCP AI rate-limit (in-memory bucket)', () => {
	afterEach(() => __resetAiBucket())

	test('[RL1] first call from new IP → allowed, remaining = AI_LIMIT - 1', () => {
		const result = checkAiRateLimit('1.2.3.4', 1_000_000)
		expect(result.allowed).toBe(true)
		expect(result.remaining).toBe(AI_LIMIT - 1)
		expect(result.limit).toBe(AI_LIMIT)
		expect(result.resetMs).toBe(AI_WINDOW_MS)
	})

	test('[RL2] N-th call within window → blocked when N > AI_LIMIT', () => {
		const ip = '5.6.7.8'
		const now = 2_000_000
		for (let i = 0; i < AI_LIMIT; i++) {
			const r = checkAiRateLimit(ip, now + i)
			expect(r.allowed).toBe(true)
		}
		const blocked = checkAiRateLimit(ip, now + AI_LIMIT + 1)
		expect(blocked.allowed).toBe(false)
		expect(blocked.remaining).toBe(0)
		expect(blocked.resetMs).toBeGreaterThan(0)
	})

	test("[RL3] IP isolation — different IPs don't share bucket", () => {
		const now = 3_000_000
		for (let i = 0; i < AI_LIMIT; i++) {
			checkAiRateLimit('ip-a', now + i)
		}
		const blockedA = checkAiRateLimit('ip-a', now + 100)
		expect(blockedA.allowed).toBe(false)
		const ipB = checkAiRateLimit('ip-b', now + 100)
		expect(ipB.allowed).toBe(true)
		expect(ipB.remaining).toBe(AI_LIMIT - 1)
	})

	test('[RL4] bucket resets after window expires', () => {
		const ip = '9.9.9.9'
		const now = 4_000_000
		for (let i = 0; i < AI_LIMIT; i++) {
			checkAiRateLimit(ip, now + i)
		}
		const blocked = checkAiRateLimit(ip, now + 100)
		expect(blocked.allowed).toBe(false)
		// Advance past window expiry
		const afterReset = checkAiRateLimit(ip, now + AI_WINDOW_MS + 1)
		expect(afterReset.allowed).toBe(true)
		expect(afterReset.remaining).toBe(AI_LIMIT - 1)
	})

	test('[RL5] remaining counter decrements monotonically within window', () => {
		const ip = '10.0.0.1'
		const now = 5_000_000
		const remainings: number[] = []
		for (let i = 0; i < 5; i++) {
			const r = checkAiRateLimit(ip, now + i)
			remainings.push(r.remaining)
		}
		expect(remainings).toEqual([
			AI_LIMIT - 1,
			AI_LIMIT - 2,
			AI_LIMIT - 3,
			AI_LIMIT - 4,
			AI_LIMIT - 5,
		])
	})

	test('[RL6] AI_LIMIT and AI_WINDOW_MS exported with expected values', () => {
		expect(AI_LIMIT).toBe(10)
		expect(AI_WINDOW_MS).toBe(5 * 60 * 1000)
	})
})
