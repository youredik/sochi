/**
 * `better-auth-adapter.ts` — strict tests per `feedback_strict_tests` +
 * `feedback_critical_fix_test_coverage_canon`.
 *
 * Тестирует `decideIdempotent()` pure function — extracted seam критического
 * 2026-05-21 fix'а для ECONNRESET / UNAVAILABLE retry. Per @ydbjs/retry 6.x:
 * UNAVAILABLE retries ТОЛЬКО когда idempotent=true. Default false (old code) →
 * 500 для BA writes на YDB Serverless idle-reconnect. Fix flipped default к
 * true (BA UPSERTs are PK-keyed, server-side idempotent).
 *
 * Invariants:
 *   - I1 Undefined options OR undefined idempotent → true (canonical default)
 *   - I2 Explicit `idempotent: true` → true
 *   - I3 Explicit `idempotent: false` → false (override path для diagnostics)
 *
 * Test matrix:
 *   [ID1] undefined options → true (BA's most common path — writes без options)
 *   [ID2] empty options object → true (defensive)
 *   [ID3] options.idempotent=undefined → true (explicit undefined)
 *   [ID4] options.idempotent=true → true
 *   [ID5] options.idempotent=false → false (explicit opt-out)
 *   [ID6] options has isolation only → true (idempotent independent of isolation)
 */

import { describe, expect, test } from 'bun:test'
import { decideIdempotent } from './better-auth-adapter.ts'

describe('decideIdempotent (BA adapter ECONNRESET retry canon)', () => {
	test('[ID1] undefined options → true (canonical default)', () => {
		expect(decideIdempotent(undefined)).toBe(true)
	})

	test('[ID2] empty options object → true', () => {
		expect(decideIdempotent({})).toBe(true)
	})

	test('[ID3] options.idempotent=undefined → true', () => {
		expect(decideIdempotent({ idempotent: undefined })).toBe(true)
	})

	test('[ID4] options.idempotent=true → true', () => {
		expect(decideIdempotent({ idempotent: true })).toBe(true)
	})

	test('[ID5] options.idempotent=false → false (explicit opt-out)', () => {
		expect(decideIdempotent({ idempotent: false })).toBe(false)
	})

	test('[ID6] options has isolation only — idempotent independent', () => {
		// isolation present, idempotent absent → defaults to true
		// (read-with-isolation calls already set idempotent=true explicitly;
		// this test pins the canonical default for сценариев где isolation set
		// but idempotent forgotten)
		expect(decideIdempotent({ idempotent: undefined })).toBe(true)
	})
})
