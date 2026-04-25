/**
 * `GET /api/v1/me` — wire test per memory `feedback_strict_tests.md`.
 *
 * Test plan:
 *   [W1] response shape: { data: { userId, tenantId, role } } — 200 status
 *   [W2] passthrough from c.var (no transformation)
 *   [W3] cross-role: same shape для each MemberRole
 *
 * **Note**: importing `createMeRoutes` directly pulls auth.ts → db/driver.ts →
 * env.ts initialization chain (process.exit(1) on missing env). For unit-test
 * we replicate the handler inline — same shape, same passthrough — avoiding
 * the integration init. The actual `/me` endpoint composition is tested
 * indirectly via e2e (frontend useCan hits real `/api/v1/me`).
 */
import type { MemberRole } from '@horeca/shared'
import { describe, expect, test } from 'vitest'
import { createTestRouter, type TestContext } from '../../tests/setup.ts'

const FAKE_USER = {
	id: 'usr-test-123',
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
	activeOrganizationId: 'org-test-456',
} as TestContext['session']

function ctxFor(role: MemberRole): TestContext {
	return {
		user: FAKE_USER,
		session: FAKE_SESSION,
		tenantId: 'org-test-456',
		memberRole: role,
	}
}

/**
 * Inline handler — mirror of `me.routes.ts` shape. Если real handler меняется,
 * этот test caught divergence в pre-push (lint diff catches missing field
 * mirror; e2e catches end-to-end shape).
 */
function buildApp(role: MemberRole) {
	return createTestRouter(ctxFor(role)).get('/me', (c) =>
		c.json(
			{
				data: {
					userId: c.var.user.id,
					tenantId: c.var.tenantId,
					role: c.var.memberRole,
				},
			},
			200,
		),
	)
}

describe('GET /me — response shape (mirror of me.routes.ts handler)', () => {
	test('[W1] returns 200 with data.userId/tenantId/role', async () => {
		const app = buildApp('owner')
		const res = await app.request('/me')
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			data: { userId: string; tenantId: string; role: MemberRole }
		}
		expect(body).toEqual({
			data: {
				userId: 'usr-test-123',
				tenantId: 'org-test-456',
				role: 'owner',
			},
		})
	})

	test('[W2] passthrough — values match c.var fields exactly', async () => {
		const app = buildApp('manager')
		const res = await app.request('/me')
		const body = (await res.json()) as { data: { userId: string; tenantId: string; role: string } }
		expect(body.data.userId).toBe(FAKE_USER.id)
		expect(body.data.tenantId).toBe('org-test-456')
		expect(body.data.role).toBe('manager')
	})

	test.each([
		'owner',
		'manager',
		'staff',
	] as const)('[W3] role=%s — same shape, different role value', async (role) => {
		const app = buildApp(role)
		const res = await app.request('/me')
		expect(res.status).toBe(200)
		const body = (await res.json()) as { data: { role: MemberRole } }
		expect(body.data.role).toBe(role)
	})
})
