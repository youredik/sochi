/**
 * `requirePermission` middleware — strict tests per memory `feedback_strict_tests.md`.
 *
 * Test plan:
 *   wire-up:
 *     [W1] middleware passes when role satisfies permissions → handler runs
 *     [W2] middleware blocks 403 with structured error when role missing perm
 *     [W3] AND-semantics: any one missing → 403
 *     [W4] empty permissions → pass-through (no-op gate)
 *
 *   role × permission matrix (sanity smoke — full matrix in rbac.test.ts):
 *     [R1] staff × refund.create → 403 (CANNOT)
 *     [R2] manager × refund.create → 200 (CAN)
 *     [R3] owner × billing.manage → 200 (CAN)
 *     [R4] manager × billing.manage → 403 (owner-only)
 *
 *   error response shape:
 *     [E1] 403 body has `error.code === 'FORBIDDEN'`
 *     [E2] 403 body includes `required` permissions для UI surfacing
 *     [E3] 403 body includes `role` для debugging
 */
import type { MemberRole } from '@horeca/shared'
import { describe, expect, test } from 'vitest'
import { createTestRouter, type TestContext } from '../tests/setup.ts'
import { requirePermission } from './require-permission.ts'

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
	expiresAt: new Date(Date.now() + 3600_000),
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

/** Build a Hono app with the middleware applied to a /probe endpoint. */
function buildProbe(role: MemberRole, permissions: Record<string, readonly string[]>) {
	return createTestRouter(ctxFor(role)).get('/probe', requirePermission(permissions), (c) =>
		c.json({ ok: true }, 200),
	)
}

describe('requirePermission — wire-up', () => {
	test('[W1] role satisfies → handler runs', async () => {
		const app = buildProbe('owner', { folio: ['read'] })
		const res = await app.request('/probe')
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true })
	})

	test('[W2] role missing perm → 403 with structured error', async () => {
		const app = buildProbe('staff', { refund: ['create'] })
		const res = await app.request('/probe')
		expect(res.status).toBe(403)
		const body = (await res.json()) as { error: { code: string; required: unknown; role: string } }
		expect(body.error.code).toBe('FORBIDDEN')
		expect(body.error.required).toEqual({ refund: ['create'] })
		expect(body.error.role).toBe('staff')
	})

	test('[W3] AND-semantics: any one missing → 403', async () => {
		// staff has folio:read но НЕ refund:create — combined check must 403
		const app = buildProbe('staff', { folio: ['read'], refund: ['create'] })
		const res = await app.request('/probe')
		expect(res.status).toBe(403)
	})

	test('[W4] empty permissions → 200 (no-op gate)', async () => {
		const app = buildProbe('staff', {})
		const res = await app.request('/probe')
		expect(res.status).toBe(200)
	})
})

describe('requirePermission — role × permission matrix smoke', () => {
	test('[R1] staff × refund.create → 403 (industry canon: financial = manager+)', async () => {
		const app = buildProbe('staff', { refund: ['create'] })
		const res = await app.request('/probe')
		expect(res.status).toBe(403)
	})

	test('[R2] manager × refund.create → 200 (manager handles refunds)', async () => {
		const app = buildProbe('manager', { refund: ['create'] })
		const res = await app.request('/probe')
		expect(res.status).toBe(200)
	})

	test('[R3] owner × billing.manage → 200 (owner has full access)', async () => {
		const app = buildProbe('owner', { billing: ['manage'] })
		const res = await app.request('/probe')
		expect(res.status).toBe(200)
	})

	test('[R4] manager × billing.manage → 403 (owner-only billing)', async () => {
		const app = buildProbe('manager', { billing: ['manage'] })
		const res = await app.request('/probe')
		expect(res.status).toBe(403)
	})

	test('staff × payment.create → 200 (front-desk collects payments)', async () => {
		const app = buildProbe('staff', { payment: ['create'] })
		const res = await app.request('/probe')
		expect(res.status).toBe(200)
	})
})

describe('requirePermission — error response shape', () => {
	test('[E1+E2+E3] 403 body has all 3 fields: code/required/role', async () => {
		const app = buildProbe('staff', { refund: ['create'], folio: ['close'] })
		const res = await app.request('/probe')
		expect(res.status).toBe(403)
		const body = (await res.json()) as {
			error: { code: string; message: string; required: unknown; role: string }
		}
		expect(body.error.code).toBe('FORBIDDEN')
		expect(body.error.message).toBe('Insufficient permissions')
		expect(body.error.required).toEqual({ refund: ['create'], folio: ['close'] })
		expect(body.error.role).toBe('staff')
	})
})
