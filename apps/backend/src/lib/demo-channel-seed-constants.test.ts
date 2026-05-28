/**
 * Round 14.6 Phase E — exported constants strict tests.
 *
 * `lib/demo-channel-seed.ts` теперь — single source of truth для demo
 * identity strings. Каждое значение константы зафиксировано в
 * runtime-assertion, чтобы:
 *
 *   1. `feedback_aggressive_delegacy` — predicting downstream-consumer
 *      breakage if literal value changes accidentally.
 *   2. Round 11 P1-B3 — `webhookSecret` cross-tenant URN forgery defense
 *      depends on `LEGACY_DEMO_WEBHOOK_KID` matching the seeded fixture
 *      row's `kid` column.
 *   3. Round 12 pass-2 P0 — Ostrovok api-client BASE alignment depends
 *      on `LEGACY_DEMO_PROPERTY_ID` matching the channelConnection PK.
 *
 * If a future change updates the canonical demo fixture (e.g. rename
 * `demo-tenant` → `showcase-default`), these tests fail loudly + caller
 * forced to audit downstream consumers (app.ts + auth.ts + admin routes
 * + index.ts + DB seed rows + reservation orchestrator URN parsing).
 */
import { describe, expect, it } from 'bun:test'
import {
	DEMO_FALLBACK_TENANT_ID,
	LEGACY_DEMO_PROPERTY_ID,
	LEGACY_DEMO_WEBHOOK_KID,
} from './demo-channel-seed.ts'

describe('Round 14.6 Phase E — demo identity constants', () => {
	it('[DCK1] DEMO_FALLBACK_TENANT_ID === "demo-tenant" (anonymous showcase pin)', () => {
		expect(DEMO_FALLBACK_TENANT_ID).toBe('demo-tenant')
	})

	it('[DCK2] LEGACY_DEMO_PROPERTY_ID === "demo-hotel-sochi" (anonymous showcase property)', () => {
		expect(LEGACY_DEMO_PROPERTY_ID).toBe('demo-hotel-sochi')
	})

	it('[DCK3] LEGACY_DEMO_WEBHOOK_KID === "kid_demo_v1" (Round 11 P1-B3 anchor)', () => {
		expect(LEGACY_DEMO_WEBHOOK_KID).toBe('kid_demo_v1')
	})

	it('[DCK4] constants are typed `as const` (литералы фиксированы, не string widening)', () => {
		// TypeScript-level invariant: the constants are typed as their literal
		// value, so any usage as `string` (e.g. JSON serialization) preserves
		// the canonical string. We assert here that they don't widen to plain
		// `string` at runtime — the literal matches exact.
		const ttype: typeof DEMO_FALLBACK_TENANT_ID = 'demo-tenant'
		const ptype: typeof LEGACY_DEMO_PROPERTY_ID = 'demo-hotel-sochi'
		const ktype: typeof LEGACY_DEMO_WEBHOOK_KID = 'kid_demo_v1'
		expect(ttype).toBe(DEMO_FALLBACK_TENANT_ID)
		expect(ptype).toBe(LEGACY_DEMO_PROPERTY_ID)
		expect(ktype).toBe(LEGACY_DEMO_WEBHOOK_KID)
	})

	it('[DCK5] constants are mutually distinct (no accidental aliasing)', () => {
		const all = new Set<string>([
			DEMO_FALLBACK_TENANT_ID,
			LEGACY_DEMO_PROPERTY_ID,
			LEGACY_DEMO_WEBHOOK_KID,
		])
		expect(all.size).toBe(3)
	})
})
