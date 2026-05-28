/**
 * Round 14.6 — production-safe demo channel seed strict tests.
 *
 * Pure-function coverage для `demoPropertyIdForOrg` derivation. Core
 * `seedDemoChannelInfraCore` DB UPSERT logic exercised в `_demo/seed.ts`
 * smoke-tests + integration tests against local YDB (`*.db.test.ts`).
 *
 * Canon: `feedback_strict_tests` — exact-value `.toBe(...)`, no weak matchers.
 */
import { describe, expect, it } from 'bun:test'
import { demoPropertyIdForOrg, demoWebhookKidForTenant } from './demo-channel-seed.ts'

describe('demoPropertyIdForOrg — synthetic property derivation', () => {
	it('[DPI1] returns deterministic `demoprop_<orgId>` shape', () => {
		expect(demoPropertyIdForOrg('org_abc123')).toBe('demoprop_org_abc123')
	})

	it('[DPI2] idempotent — same input → same output', () => {
		const a = demoPropertyIdForOrg('org_xyz')
		const b = demoPropertyIdForOrg('org_xyz')
		expect(a).toBe(b)
	})

	it('[DPI3] distinct orgs → distinct property IDs (no collision)', () => {
		const a = demoPropertyIdForOrg('org_alpha')
		const b = demoPropertyIdForOrg('org_beta')
		expect(a).not.toBe(b)
		expect(a).toBe('demoprop_org_alpha')
		expect(b).toBe('demoprop_org_beta')
	})

	it('[DPI4] empty orgId → still produces prefix (boundary check)', () => {
		// Defensive: function should not throw on empty input. Caller wraps the
		// guard upstream, but the function itself must be total.
		expect(demoPropertyIdForOrg('')).toBe('demoprop_')
	})
})

describe('demoWebhookKidForTenant — per-tenant kid derivation', () => {
	it('[DWK1] legacy `demo-tenant` retains the original `kid_demo_v1` для backwards-compat', () => {
		expect(demoWebhookKidForTenant('demo-tenant')).toBe('kid_demo_v1')
	})

	it('[DWK2] new org gets per-tenant `kid_demo_<orgId>` (isolation от legacy slot)', () => {
		expect(demoWebhookKidForTenant('org_abc')).toBe('kid_demo_org_abc')
	})

	it('[DWK3] distinct orgs → distinct kids (no PK collision in webhookSecret)', () => {
		const a = demoWebhookKidForTenant('org_alpha')
		const b = demoWebhookKidForTenant('org_beta')
		expect(a).not.toBe(b)
	})

	it('[DWK4] same orgId → same kid (deterministic for idempotent UPSERT)', () => {
		const a = demoWebhookKidForTenant('org_x')
		const b = demoWebhookKidForTenant('org_x')
		expect(a).toBe(b)
	})
})
