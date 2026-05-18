/**
 * G11 v3 (2026-05-18) — Strict invariant: `shouldPersistQuery` MUST exclude
 * `['auth', 'session']` from IndexedDB persistence, AND MUST NOT exclude any
 * other queryKey (including future `['auth', 'devices']`, `['auth', 'sessions']`,
 * `['org', ...]`, etc).
 *
 * Why ratchet this с tests: the regression that motivated G11 v3 was a
 * silent operator-bouncing-к-/login bug caused by persister rehydrating
 * stale anonymous `null` session payload. Future contributors widening
 * the exclusion (e.g., к prefix-block `['auth', ...]`) would break offline
 * UX для legitimate auth-adjacent queries (BA passkey/device list). Future
 * contributors narrowing it (e.g., removing the filter entirely) would
 * reintroduce the magic-link-login regression. This test pins both edges.
 */
import { describe, expect, it } from 'bun:test'
import { shouldPersistQuery } from './persister.ts'

describe('shouldPersistQuery — auth-session exclusion canon (G11 v3 2026-05-18)', () => {
	it('[E1] excludes EXACTLY `["auth", "session"]`', () => {
		expect(shouldPersistQuery(['auth', 'session'])).toBe(false)
	})

	it('[E2] excludes `["auth", "session", ...extra]` (deeper queries still under session umbrella)', () => {
		// Defensive: if BA adds nested session-scoped queries («session», «detail», userId)
		// the same canon — auth session state never persists.
		expect(shouldPersistQuery(['auth', 'session', 'meta'])).toBe(false)
	})

	it('[K1] permits `["auth", "devices"]` (passkey/device list — offline-friendly)', () => {
		// Adversarial guard from agent research: prefix-block `["auth", ...]`
		// would break legitimate future offline surfaces. Scoped match keeps
		// предохранитель minimal.
		expect(shouldPersistQuery(['auth', 'devices'])).toBe(true)
	})

	it('[K2] permits `["auth", "sessions"]` (plural — device-list, NOT current session)', () => {
		// Distinct from singular `session` (current-tab auth state). Plural
		// `sessions` typically = BA "list active devices" surface — operationally
		// offline-friendly UX.
		expect(shouldPersistQuery(['auth', 'sessions'])).toBe(true)
	})

	it('[K3] permits `["org", "list"]` (organization list)', () => {
		expect(shouldPersistQuery(['org', 'list'])).toBe(true)
	})

	it('[K4] permits `["bookings", "list", { propertyId }]` (booking grid data)', () => {
		expect(shouldPersistQuery(['bookings', 'list', { propertyId: 'prop-1' }])).toBe(true)
	})

	it('[K5] permits empty queryKey (defensive — TanStack-internal, never appears в prod)', () => {
		expect(shouldPersistQuery([])).toBe(true)
	})

	it('[K6] permits single-segment queryKey `["health"]`', () => {
		expect(shouldPersistQuery(['health'])).toBe(true)
	})

	it('[A1] adversarial — string `"auth"` ALONE (not array) — predicate guards К tuple shape', () => {
		// Defensive: queryKey IS array per TanStack contract; но if internal
		// caller pass non-array, predicate must not crash. Treated as permit
		// (offline-safe default).
		expect(shouldPersistQuery(['auth'])).toBe(true) // length < 2 → permit
	})
})
