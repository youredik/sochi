/**
 * Strict tests for the idempotency util — `feedback_strict_tests.md`.
 *
 * Test matrix:
 *   ─── freshIdempotencyKey ─────────────────────────────────────────
 *     [F1] returns a string of UUIDv4 shape (RFC 4122 v4: 36 chars,
 *          version-nibble='4', variant-nibble in [89ab])
 *     [F2] two consecutive calls return DIFFERENT keys (uniqueness)
 *     [F3] 1000 calls → 1000 distinct keys (no clustering)
 *
 *   ─── useIdempotencyKey hook ──────────────────────────────────────
 *     [H1] stable across re-renders (same instance returns same key)
 *     [H2] new instance → new key
 *     [H3] returned value matches UUIDv4 shape
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { freshIdempotencyKey, useIdempotencyKey } from './idempotency.ts'

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('freshIdempotencyKey', () => {
	test('[F1] returns a UUIDv4-shaped string', () => {
		const k = freshIdempotencyKey()
		expect(typeof k).toBe('string')
		expect(k).toMatch(UUID_V4_REGEX)
	})

	test('[F2] two consecutive calls return different keys', () => {
		expect(freshIdempotencyKey()).not.toBe(freshIdempotencyKey())
	})

	test('[F3] 1000 calls → 1000 distinct keys (no clustering)', () => {
		const keys = new Set<string>()
		for (let i = 0; i < 1000; i++) keys.add(freshIdempotencyKey())
		expect(keys.size).toBe(1000)
	})
})

describe('useIdempotencyKey', () => {
	test('[H1] stable across re-renders (memoized per mount)', () => {
		const { result, rerender } = renderHook(() => useIdempotencyKey())
		const first = result.current
		rerender()
		rerender()
		rerender()
		expect(result.current).toBe(first)
	})

	test('[H2] new instance → new key', () => {
		const { result: a } = renderHook(() => useIdempotencyKey())
		const { result: b } = renderHook(() => useIdempotencyKey())
		expect(a.current).not.toBe(b.current)
	})

	test('[H3] returned value matches UUIDv4 shape', () => {
		const { result } = renderHook(() => useIdempotencyKey())
		expect(result.current).toMatch(UUID_V4_REGEX)
	})
})
