/**
 * Strict tests для booking-find routes (M9.widget.5 / A3.1.c).
 *
 * Pure unit + structural — TupleKeyStore + internal constants. Full happy-path
 * DB integration covered via empirical curl + A3.4 E2E (frontend session).
 *
 * Coverage matrix:
 *   ─── Internal helpers ────────────────────────────────────────
 *     [BFND-INT1] makeTupleKey deterministic same input → same output
 *     [BFND-INT2] makeTupleKey different inputs → different keys
 *     [BFND-INT3] TUPLE_KEY_LIMIT = 5
 *     [BFND-INT4] TUPLE_KEY_WINDOW_MS = 15min
 *     [BFND-INT5] FIXED_RESPONSE_MS = 800
 *
 *   ─── TupleKeyStore (in-memory rate-limit) ────────────────────
 *     [BFND-TS1] first 5 calls allow → 6th denied
 *     [BFND-TS2] window expiry resets counter
 *     [BFND-TS3] different tuples independent counters
 *     [BFND-TS4] reset() clears all counters
 *     [BFND-TS5] remaining counter decrements correctly
 *     [BFND-TS6] resetAt monotonic — earlier resetAt for first call
 */

import { describe, expect, test } from 'vitest'
import { __testInternals, TupleKeyStore } from './booking-find.routes.ts'

describe('booking-find — internal helpers', () => {
	test('[BFND-INT1] makeTupleKey deterministic same input → same output', () => {
		const a = __testInternals.makeTupleKey('user@a.com', 'book_1')
		const b = __testInternals.makeTupleKey('user@a.com', 'book_1')
		expect(a).toBe(b)
	})

	test('[BFND-INT2] makeTupleKey different (email, ref) → different keys', () => {
		expect(__testInternals.makeTupleKey('user@a.com', 'book_1')).not.toBe(
			__testInternals.makeTupleKey('user@a.com', 'book_2'),
		)
		expect(__testInternals.makeTupleKey('alice@a.com', 'book_1')).not.toBe(
			__testInternals.makeTupleKey('bob@a.com', 'book_1'),
		)
	})

	test('[BFND-INT3] TUPLE_KEY_LIMIT = 5', () => {
		expect(__testInternals.TUPLE_KEY_LIMIT).toBe(5)
	})

	test('[BFND-INT4] TUPLE_KEY_WINDOW_MS = 15min', () => {
		expect(__testInternals.TUPLE_KEY_WINDOW_MS).toBe(15 * 60 * 1000)
	})

	test('[BFND-INT5] FIXED_RESPONSE_MS = 800', () => {
		expect(__testInternals.FIXED_RESPONSE_MS).toBe(800)
	})
})

describe('TupleKeyStore (in-memory rate-limit)', () => {
	test('[BFND-TS1] first 5 calls allow → 6th denied', () => {
		const store = new TupleKeyStore()
		const now = Date.now()
		for (let i = 0; i < 5; i++) {
			const r = store.check('a@b.c::ref', now)
			expect(r.allowed).toBe(true)
			expect(r.remaining).toBe(4 - i)
		}
		const sixth = store.check('a@b.c::ref', now)
		expect(sixth.allowed).toBe(false)
		expect(sixth.remaining).toBe(0)
	})

	test('[BFND-TS2] window expiry resets counter', () => {
		const store = new TupleKeyStore()
		const t0 = 1000
		for (let i = 0; i < 5; i++) store.check('a@b.c::ref', t0)
		// 6th — denied
		expect(store.check('a@b.c::ref', t0).allowed).toBe(false)
		// After window — allowed again (fresh counter)
		const tAfter = t0 + 15 * 60 * 1000 + 1
		const fresh = store.check('a@b.c::ref', tAfter)
		expect(fresh.allowed).toBe(true)
		expect(fresh.remaining).toBe(4)
	})

	test('[BFND-TS3] different tuples independent counters', () => {
		const store = new TupleKeyStore()
		const now = Date.now()
		for (let i = 0; i < 5; i++) store.check('a@b.c::ref1', now)
		// First key exhausted, second key fresh
		expect(store.check('a@b.c::ref1', now).allowed).toBe(false)
		expect(store.check('a@b.c::ref2', now).allowed).toBe(true)
	})

	test('[BFND-TS4] reset() clears all counters', () => {
		const store = new TupleKeyStore()
		const now = Date.now()
		for (let i = 0; i < 5; i++) store.check('a@b.c::ref', now)
		expect(store.check('a@b.c::ref', now).allowed).toBe(false)
		store.reset()
		expect(store.check('a@b.c::ref', now).allowed).toBe(true)
	})

	test('[BFND-TS5] remaining counter decrements correctly', () => {
		const store = new TupleKeyStore()
		const now = Date.now()
		expect(store.check('a@b.c::ref', now).remaining).toBe(4) // 1st, 4 left
		expect(store.check('a@b.c::ref', now).remaining).toBe(3)
		expect(store.check('a@b.c::ref', now).remaining).toBe(2)
		expect(store.check('a@b.c::ref', now).remaining).toBe(1)
		expect(store.check('a@b.c::ref', now).remaining).toBe(0) // 5th
		expect(store.check('a@b.c::ref', now).remaining).toBe(0) // 6th — denied, still 0
	})

	test('[BFND-TS6] resetAt set on first call', () => {
		const store = new TupleKeyStore()
		const now = 1000
		const r = store.check('a@b.c::ref', now)
		expect(r.resetAt).toBe(now + 15 * 60 * 1000)
	})
})
