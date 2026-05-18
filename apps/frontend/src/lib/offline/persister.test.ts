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

describe('shouldPersistQuery — auth-session + meta.persist canon (G11 v3 2026-05-18)', () => {
	it('[E1] excludes EXACTLY `["auth", "session"]`', () => {
		expect(shouldPersistQuery(['auth', 'session'])).toBe(false)
	})

	it('[E2] excludes `["auth", "session", ...extra]` (deeper queries still under session umbrella)', () => {
		expect(shouldPersistQuery(['auth', 'session', 'meta'])).toBe(false)
	})

	it('[K1] permits `["auth", "devices"]` (passkey/device list — offline-friendly)', () => {
		expect(shouldPersistQuery(['auth', 'devices'])).toBe(true)
	})

	it('[K2] permits `["auth", "sessions"]` (plural — device-list, NOT current session)', () => {
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

	it('[A1] adversarial — `["auth"]` alone (length < 2) → permit', () => {
		expect(shouldPersistQuery(['auth'])).toBe(true)
	})

	// G11 v3 meta.persist canon (2026-05-18) — per-query opt-out via meta hint.
	// TanStack TkDodo canonical pattern; PII-bearing queries tag themselves.
	// Test pin'ит both edges чтобы future contributor не сломал contract.
	it('[M1] meta.persist === false → EXCLUDE (canonical opt-out)', () => {
		expect(shouldPersistQuery(['booking', 'detail', 'book_abc'], { persist: false })).toBe(false)
	})

	it('[M2] meta.persist === true → respect queryKey logic (still excludes auth-session)', () => {
		expect(shouldPersistQuery(['auth', 'session'], { persist: true })).toBe(false)
	})

	it('[M3] meta.persist === undefined → fall-through к queryKey logic (PERMIT non-auth)', () => {
		expect(shouldPersistQuery(['bookings', 'grid', 'prop-1'], {})).toBe(true)
	})

	it('[M4] meta missing entirely → fall-through (PERMIT non-auth)', () => {
		expect(shouldPersistQuery(['bookings', 'grid', 'prop-1'])).toBe(true)
	})

	it('[M5] meta.persist === false на PII detail query (`["booking", id]`) → EXCLUDE', () => {
		// Real-world: `useBooking(id)` opts out — full guestSnapshot stays
		// in-memory only, never IndexedDB. 152-ФЗ-compliant detail-fetch.
		expect(shouldPersistQuery(['booking', 'book_abc123'], { persist: false })).toBe(false)
	})

	it('[M6] meta.persist === false на unassigned list (с PII guestSnapshot) → EXCLUDE', () => {
		expect(shouldPersistQuery(['unassigned', 'prop-1'], { persist: false })).toBe(false)
	})
})
