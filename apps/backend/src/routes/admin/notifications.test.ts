/**
 * Admin notifications routes — wire-up tests per memory `feedback_strict_tests.md`.
 *
 * Test plan:
 *   RBAC (validates `requirePermission({ notification: ['read' | 'retry'] })`):
 *     [R1] staff GET /notifications        → 403
 *     [R2] staff GET /notifications/:id    → 403
 *     [R3] staff POST /notifications/:id/retry → 403
 *     [R4] manager GET /notifications      → 200
 *     [R5] manager POST /notifications/:id/retry → 200
 *     [R6] owner all endpoints             → 200
 *
 *   List endpoint:
 *     [L1] returns `{ data: { items, nextCursor } }` shape
 *     [L2] zValidator catches invalid status enum → 400
 *     [L3] zValidator catches limit > 100 → 400
 *     [L4] zValidator catches from > to → 400
 *
 *   Get single:
 *     [G1] valid id → 200 with detail shape
 *     [G2] not-found → 404
 *     [G3] zValidator catches non-typedID prefix → 400
 *
 *   Retry endpoint:
 *     [P1] success → 200 with detail shape
 *     [P2] not-found → 404 with structured error
 *     [P3] already-sent → 409 with structured error + code
 *     [P4] zValidator catches non-typedID → 400
 */
import type { MemberRole, NotificationDetail, NotificationListPage } from '@horeca/shared'
import { describe, expect, test } from 'vitest'
import type { NotificationService } from '../../domains/notification/notification.service.ts'
import { NotificationAlreadySentError, NotificationNotFoundError } from '../../errors/domain.ts'
import { onError } from '../../errors/on-error.ts'
import { createTestRouter, type TestContext } from '../../tests/setup.ts'
import { createAdminNotificationsRoutesInner } from './notifications.ts'

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

const FAKE_PAGE: NotificationListPage = {
	items: [
		{
			tenantId: 'org-test',
			id: 'ntf_01abc',
			kind: 'payment_succeeded',
			channel: 'email',
			recipient: 'guest@host.local',
			subject: 'Платёж получен',
			bodyText: 'Спасибо за оплату',
			payloadJson: { amount: 1500 },
			status: 'sent',
			sentAt: '2026-04-26T10:00:00.000Z',
			failedAt: null,
			failureReason: null,
			retryCount: 1,
			sourceObjectType: 'payment',
			sourceObjectId: 'pay_01',
			sourceEventDedupKey: 'payment:pay_01:payment_succeeded',
			createdAt: '2026-04-26T09:55:00.000Z',
			updatedAt: '2026-04-26T10:00:00.000Z',
			createdBy: 'system',
			updatedBy: 'system:notification_dispatcher',
		},
	],
	nextCursor: null,
}

const FAKE_DETAIL: NotificationDetail = {
	notification: FAKE_PAGE.items[0]!,
	attempts: [{ kind: 'sent', at: '2026-04-26T10:00:00.000Z', reason: null }],
	nextAttemptAt: null,
	messageId: 'stub-1',
}

interface FakeServiceOpts {
	getDetailReturns?: NotificationDetail | null
	markForRetryThrows?: Error
}

function buildFakeService(opts: FakeServiceOpts = {}): NotificationService {
	return {
		list: async () => FAKE_PAGE,
		// `??` would coerce intentional null → fallback. Explicit `'in' check
		// preserves "explicitly null" caller intent (G2 test).
		getDetail: async () =>
			'getDetailReturns' in opts ? (opts.getDetailReturns ?? null) : FAKE_DETAIL,
		markForRetry: async () => {
			if (opts.markForRetryThrows) throw opts.markForRetryThrows
			return FAKE_DETAIL
		},
	}
}

function buildApp(role: MemberRole, opts: FakeServiceOpts = {}) {
	const service = buildFakeService(opts)
	const app = createTestRouter(ctxFor(role)).route(
		'/api/admin',
		createAdminNotificationsRoutesInner(service),
	)
	// Mount the production onError handler so domain errors map to proper
	// HTTP status codes (NotificationNotFoundError → 404 etc).
	app.onError(onError)
	return app
}

// ----------------------------------------------------------------- RBAC

describe('admin notifications — RBAC', () => {
	test('[R1] staff GET /notifications → 403', async () => {
		const app = buildApp('staff')
		const res = await app.request('/api/admin/notifications')
		expect(res.status).toBe(403)
	})
	test('[R2] staff GET /notifications/:id → 403', async () => {
		const app = buildApp('staff')
		const res = await app.request('/api/admin/notifications/ntf_01abc')
		expect(res.status).toBe(403)
	})
	test('[R3] staff POST /notifications/:id/retry → 403', async () => {
		const app = buildApp('staff')
		const res = await app.request('/api/admin/notifications/ntf_01abc/retry', {
			method: 'POST',
		})
		expect(res.status).toBe(403)
	})
	test('[R4] manager GET /notifications → 200', async () => {
		const app = buildApp('manager')
		const res = await app.request('/api/admin/notifications')
		expect(res.status).toBe(200)
	})
	test('[R5] manager POST /notifications/:id/retry → 200', async () => {
		const app = buildApp('manager')
		const res = await app.request('/api/admin/notifications/ntf_01abc/retry', {
			method: 'POST',
		})
		expect(res.status).toBe(200)
	})
	test('[R6] owner all endpoints → 200', async () => {
		const app = buildApp('owner')
		const list = await app.request('/api/admin/notifications')
		const get = await app.request('/api/admin/notifications/ntf_01abc')
		const retry = await app.request('/api/admin/notifications/ntf_01abc/retry', {
			method: 'POST',
		})
		expect(list.status).toBe(200)
		expect(get.status).toBe(200)
		expect(retry.status).toBe(200)
	})
})

// ----------------------------------------------------------------- list

describe('admin notifications — list endpoint', () => {
	test('[L1] returns { data: { items, nextCursor } } shape', async () => {
		const app = buildApp('owner')
		const res = await app.request('/api/admin/notifications')
		expect(res.status).toBe(200)
		const body = (await res.json()) as { data: NotificationListPage }
		expect(Array.isArray(body.data.items)).toBe(true)
		expect(body.data.items[0]?.id).toBe('ntf_01abc')
		expect(body.data.nextCursor).toBeNull()
	})
	test('[L2] invalid status enum → 400', async () => {
		const app = buildApp('owner')
		const res = await app.request('/api/admin/notifications?status=DEFINITELY_INVALID')
		expect(res.status).toBe(400)
	})
	test('[L3] limit > 100 → 400', async () => {
		const app = buildApp('owner')
		const res = await app.request('/api/admin/notifications?limit=200')
		expect(res.status).toBe(400)
	})
	test('[L4] from > to → 400', async () => {
		const app = buildApp('owner')
		const res = await app.request('/api/admin/notifications?from=2026-12-01&to=2026-01-01')
		expect(res.status).toBe(400)
	})
})

// ----------------------------------------------------------------- get one

describe('admin notifications — get single', () => {
	test('[G1] valid id → 200 with detail shape', async () => {
		const app = buildApp('owner')
		const res = await app.request('/api/admin/notifications/ntf_01abc')
		expect(res.status).toBe(200)
		const body = (await res.json()) as { data: NotificationDetail }
		expect(body.data.notification.id).toBe('ntf_01abc')
		expect(body.data.attempts).toHaveLength(1)
		expect(body.data.attempts[0]?.kind).toBe('sent')
	})
	test('[G2] not-found → 404', async () => {
		const app = buildApp('owner', { getDetailReturns: null })
		const res = await app.request('/api/admin/notifications/ntf_absent00')
		expect(res.status).toBe(404)
	})
	test('[G3] non-typedID prefix → 400', async () => {
		const app = buildApp('owner')
		const res = await app.request('/api/admin/notifications/not_a_typed_id')
		expect(res.status).toBe(400)
	})
})

// ----------------------------------------------------------------- retry

describe('admin notifications — retry endpoint', () => {
	test('[P1] success → 200 with detail shape', async () => {
		const app = buildApp('owner')
		const res = await app.request('/api/admin/notifications/ntf_01abc/retry', {
			method: 'POST',
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { data: NotificationDetail }
		expect(body.data.notification.id).toBe('ntf_01abc')
	})
	test('[P2] not-found → 404 with structured error', async () => {
		const app = buildApp('owner', {
			markForRetryThrows: new NotificationNotFoundError('ntf_absent00'),
		})
		const res = await app.request('/api/admin/notifications/ntf_absent00/retry', {
			method: 'POST',
		})
		expect(res.status).toBe(404)
		const body = (await res.json()) as { error: { code: string; message: string } }
		expect(body.error.code).toBe('NOT_FOUND')
	})
	test('[P3] already-sent → 409 with structured error code', async () => {
		const app = buildApp('owner', {
			markForRetryThrows: new NotificationAlreadySentError('ntf_01abc'),
		})
		const res = await app.request('/api/admin/notifications/ntf_01abc/retry', {
			method: 'POST',
		})
		expect(res.status).toBe(409)
		const body = (await res.json()) as { error: { code: string; message: string } }
		expect(body.error.code).toBe('NOTIFICATION_ALREADY_SENT')
	})
	test('[P4] non-typedID → 400', async () => {
		const app = buildApp('owner')
		const res = await app.request('/api/admin/notifications/garbage_id/retry', {
			method: 'POST',
		})
		expect(res.status).toBe(400)
	})
})
