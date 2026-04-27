/**
 * Tenant compliance routes — RBAC + happy-path + 404 + cross-field warnings.
 *
 * Per `feedback_strict_tests.md`:
 *   - RBAC matrix exhaustive: staff (no read/update), manager (read only),
 *     owner (read + update)
 *   - Zod boundary: invalid taxRegime → 400; empty patch → 400
 *   - Cross-field invariant: response carries `warnings` array
 *   - Missing tenant row → 404 (NOT silently inserts)
 */
import type { MemberRole, TenantCompliance, TenantCompliancePatch } from '@horeca/shared'
import { describe, expect, test } from 'vitest'
import { onError } from '../../errors/on-error.ts'
import { createTestRouter, type TestContext } from '../../tests/setup.ts'
import type { TenantComplianceFactory } from './compliance.factory.ts'
import { createTenantComplianceRoutesInner } from './compliance.routes.ts'

const FAKE_USER = {
	id: 'usr-test',
	email: 'test@sochi.local',
	emailVerified: true,
	name: 'Test',
	createdAt: new Date(),
	updatedAt: new Date(),
} as TestContext['user']

const FAKE_SESSION = {
	id: 'ses-test',
	userId: FAKE_USER.id,
	expiresAt: new Date(Date.now() + 3_600_000),
	token: 'tok',
	createdAt: new Date(),
	updatedAt: new Date(),
	ipAddress: '127.0.0.1',
	userAgent: 'test',
	activeOrganizationId: 'org-test',
} as TestContext['session']

function ctxFor(role: MemberRole): TestContext {
	return {
		user: FAKE_USER,
		session: FAKE_SESSION,
		tenantId: 'org-test',
		memberRole: role,
	}
}

const FAKE_COMPLIANCE: TenantCompliance = {
	ksrRegistryId: 'KSR-001',
	ksrCategory: 'guest_house',
	legalEntityType: 'ip',
	taxRegime: 'USN_DOHODY',
	annualRevenueEstimateMicroRub: 5_000_000_000_000n,
	guestHouseFz127Registered: true,
	ksrVerifiedAt: '2026-04-27T10:00:00.000Z',
}

interface FakeRepoOpts {
	getReturns?: TenantCompliance | null
	patchReturns?: TenantCompliance | null
	patchSpy?: (patch: TenantCompliancePatch) => void
}

function buildFactory(opts: FakeRepoOpts = {}): TenantComplianceFactory {
	return {
		repo: {
			get: async () => ('getReturns' in opts ? (opts.getReturns ?? null) : FAKE_COMPLIANCE),
			patch: async (_t, patch) => {
				opts.patchSpy?.(patch)
				return 'patchReturns' in opts ? (opts.patchReturns ?? null) : FAKE_COMPLIANCE
			},
		},
	}
}

function buildApp(role: MemberRole, opts: FakeRepoOpts = {}) {
	const app = createTestRouter(ctxFor(role)).route(
		'/api/v1',
		createTenantComplianceRoutesInner(buildFactory(opts)),
	)
	app.onError(onError)
	return app
}

describe('compliance routes — RBAC matrix', () => {
	test('[R1] staff GET /me/compliance → 403', async () => {
		const res = await buildApp('staff').request('/api/v1/me/compliance')
		expect(res.status).toBe(403)
	})

	test('[R2] staff PATCH /me/compliance → 403', async () => {
		const res = await buildApp('staff').request('/api/v1/me/compliance', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ksrRegistryId: 'X' }),
		})
		expect(res.status).toBe(403)
	})

	test('[R3] manager GET → 200 (manager has read)', async () => {
		const res = await buildApp('manager').request('/api/v1/me/compliance')
		expect(res.status).toBe(200)
	})

	test('[R4] manager PATCH → 403 (compliance update is owner-only per 152-ФЗ)', async () => {
		const res = await buildApp('manager').request('/api/v1/me/compliance', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ksrRegistryId: 'X' }),
		})
		expect(res.status).toBe(403)
	})

	test('[R5] owner GET + PATCH → 200', async () => {
		const get = await buildApp('owner').request('/api/v1/me/compliance')
		const patch = await buildApp('owner').request('/api/v1/me/compliance', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ksrRegistryId: 'X' }),
		})
		expect(get.status).toBe(200)
		expect(patch.status).toBe(200)
	})
})

describe('compliance routes — GET /me/compliance', () => {
	test('[G1] returns { data: TenantCompliance } shape', async () => {
		const res = await buildApp('owner').request('/api/v1/me/compliance')
		expect(res.status).toBe(200)
		const body = (await res.json()) as { data: TenantCompliance }
		expect(body.data.ksrRegistryId).toBe('KSR-001')
		expect(body.data.ksrCategory).toBe('guest_house')
	})

	test('[G2] missing row → 404 (NOT silent insert)', async () => {
		const res = await buildApp('owner', { getReturns: null }).request('/api/v1/me/compliance')
		expect(res.status).toBe(404)
	})
})

describe('compliance routes — PATCH /me/compliance', () => {
	test('[P1] valid single-field patch → 200', async () => {
		let captured: TenantCompliancePatch | undefined
		const res = await buildApp('owner', {
			patchSpy: (p) => {
				captured = p
			},
		}).request('/api/v1/me/compliance', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ksrRegistryId: 'NEW' }),
		})
		expect(res.status).toBe(200)
		expect(captured).toEqual({ ksrRegistryId: 'NEW' })
	})

	test('[P2] empty patch → 400 (Zod refine "at least one field")', async () => {
		const res = await buildApp('owner').request('/api/v1/me/compliance', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		})
		expect(res.status).toBe(400)
	})

	test('[P3] invalid taxRegime → 400 (Zod enum)', async () => {
		const res = await buildApp('owner').request('/api/v1/me/compliance', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ taxRegime: 'EXOTIC_REGIME' }),
		})
		expect(res.status).toBe(400)
	})

	test('[P4] invalid ksrCategory → 400', async () => {
		const res = await buildApp('owner').request('/api/v1/me/compliance', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ksrCategory: 'motel' }),
		})
		expect(res.status).toBe(400)
	})

	test('[P5] missing row → 404 (NOT silent create)', async () => {
		const res = await buildApp('owner', { patchReturns: null }).request('/api/v1/me/compliance', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ksrRegistryId: 'X' }),
		})
		expect(res.status).toBe(404)
	})

	test('[P6] response surfaces guest-house invariant warning when applicable', async () => {
		// Patch result simulates a violation: guest_house category but null
		// FZ-127 flag.
		const violatingResult: TenantCompliance = {
			...FAKE_COMPLIANCE,
			ksrCategory: 'guest_house',
			guestHouseFz127Registered: null,
		}
		const res = await buildApp('owner', { patchReturns: violatingResult }).request(
			'/api/v1/me/compliance',
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ksrCategory: 'guest_house' }),
			},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { data: TenantCompliance; warnings: string[] }
		expect(body.warnings.some((w) => /ФЗ-127/.test(w))).toBe(true)
	})

	test('[P7] response surfaces tax-regime invariant warning when applicable', async () => {
		const violatingResult: TenantCompliance = {
			...FAKE_COMPLIANCE,
			ksrCategory: null,
			guestHouseFz127Registered: null,
			legalEntityType: 'npd',
			taxRegime: 'USN_DOHODY', // npd must be NPD
		}
		const res = await buildApp('owner', { patchReturns: violatingResult }).request(
			'/api/v1/me/compliance',
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ taxRegime: 'USN_DOHODY' }),
			},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { data: TenantCompliance; warnings: string[] }
		expect(body.warnings.some((w) => /Самозанятый/.test(w))).toBe(true)
	})

	test('[P8] response carries empty warnings when invariants OK', async () => {
		const res = await buildApp('owner').request('/api/v1/me/compliance', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ksrRegistryId: 'X' }),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { data: TenantCompliance; warnings: string[] }
		expect(body.warnings).toEqual([])
	})
})
