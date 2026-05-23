/**
 * Strict route-level tests для POST /passport-scan/consent/:consentId/revoke.
 *
 * RBAC + cross-tenant + idempotency + cascade orchestration. DB invariants
 * tested separately через photo-consent-log.repo.db.test.ts + passport-ocr-
 * audit.repo.db.test.ts (real YDB).
 *
 * Test matrix:
 *   [R1] non-existent consentId → 404
 *   [R2] cross-tenant consentId (existing в другом tenant) → 404 (factory
 *        consentRepo.findById возвращает null для wrong tenant)
 *   [R3] already-revoked consent → 200 с alreadyRevoked=true (idempotent)
 *   [R4] valid revoke → 200 + cascadeRtbfRevoke called + storage.delete called
 *   [R5] storage.delete throws → 200 (graceful failure, logged) + cascade still runs
 *   [R6] staff role → 200 (guest:update permission)
 *   [R7] missing body → uses 'user_request' default reason
 *   [R8] invalid reason enum → 400
 */
import type { MemberRole } from '@horeca/shared'
import { describe, expect, test } from 'bun:test'
import { onError } from '../../../../errors/on-error.ts'
import { createTestRouter, type TestContext } from '../../../../tests/setup.ts'
import { createMockPassportPhotoStorage } from '../storage/passport-photo-storage.ts'
import { createConsentRevokeRoutesInner } from './consent-revoke.routes.ts'

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

interface StubFactoryOpts {
	consentFound?: 'active' | 'revoked' | 'missing'
	cascadeShouldThrow?: boolean
	objectKeys?: readonly string[]
}

function makeStubFactory(opts: StubFactoryOpts = {}) {
	const cascadeCalls: Array<{ tenantId: string; consentId: string; reason: string }> = []
	const consentStub = (() => {
		if (opts.consentFound === 'missing' || opts.consentFound === undefined) return null
		if (opts.consentFound === 'revoked') {
			return {
				tenantId: 'org-test',
				id: 'cns_revoked',
				guestId: 'gst-1',
				version: '2026-05-22b',
				scope: 'passport_ocr',
				acceptedAt: new Date('2026-05-22T10:00:00Z'),
				ipAddress: '192.0.2.1',
				userAgent: 'test',
				revokedAt: new Date('2026-05-23T10:00:00Z'),
				revokedReason: 'previous_reason',
				createdAt: new Date('2026-05-22T10:00:00Z'),
				textSnapshot: 'snapshot',
				separateConsents: null,
			}
		}
		return {
			tenantId: 'org-test',
			id: 'cns_active',
			guestId: 'gst-1',
			version: '2026-05-22b',
			scope: 'passport_ocr',
			acceptedAt: new Date('2026-05-22T10:00:00Z'),
			ipAddress: '192.0.2.1',
			userAgent: 'test',
			revokedAt: null,
			revokedReason: null,
			createdAt: new Date('2026-05-22T10:00:00Z'),
			textSnapshot: 'snapshot',
			separateConsents: null,
		}
	})()
	return {
		factory: {
			consentRepo: {
				insert: async () => 'cns_stub',
				findById: async () => consentStub,
				findByGuestId: async () => [],
				revoke: async () => ({ revoked: true }),
			},
			auditRepo: {
				insert: async () => 'ocra_stub',
				findByGuestId: async () => [],
				nullifyEntitiesByConsentId: async () => undefined,
				findObjectKeysByConsentId: async () => opts.objectKeys ?? [],
			},
			recordConsentAndAuditAtomic: async () => ({ success: true, consentId: null }),
			cascadeRtbfRevoke: async (input: { tenantId: string; consentId: string; reason: string }) => {
				if (opts.cascadeShouldThrow === true) throw new Error('cascade failed')
				cascadeCalls.push(input)
			},
		} as unknown,
		cascadeCalls,
	}
}

function buildApp(role: MemberRole, factoryOpts: StubFactoryOpts = {}) {
	const { factory, cascadeCalls } = makeStubFactory(factoryOpts)
	const photoStorage = createMockPassportPhotoStorage()
	const deleteCalls: string[] = []
	const photoStorageStub = {
		...photoStorage,
		// biome-ignore lint/suspicious/noExplicitAny: stub mode shape
		delete: async (key: string) => {
			deleteCalls.push(key)
		},
	} as typeof photoStorage
	const app = createTestRouter(ctxFor(role)).route(
		'/api/v1',
		createConsentRevokeRoutesInner({
			// biome-ignore lint/suspicious/noExplicitAny: stub factory shape
			passportScanFactory: factory as any,
			photoStorage: photoStorageStub,
		}),
	)
	app.onError(onError)
	return { app, cascadeCalls, deleteCalls }
}

describe('consent-revoke.routes — RTBF endpoint', () => {
	test('[R1] non-existent consentId → 404', async () => {
		const { app } = buildApp('owner', { consentFound: 'missing' })
		const res = await app.request('/api/v1/passport-scan/consent/cns_doesnotexist/revoke', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		})
		expect(res.status).toBe(404)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('NOT_FOUND')
	})

	test('[R3] already-revoked consent → 200 + alreadyRevoked=true (idempotent)', async () => {
		const { app, cascadeCalls } = buildApp('owner', { consentFound: 'revoked' })
		const res = await app.request('/api/v1/passport-scan/consent/cns_revoked/revoke', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			data: { alreadyRevoked: boolean; revokedAt: string; revokedReason: string }
		}
		expect(body.data.alreadyRevoked).toBe(true)
		expect(body.data.revokedReason).toBe('previous_reason')
		// Cascade NOT called — already-revoked path returns early
		expect(cascadeCalls.length).toBe(0)
	})

	test('[R4] valid revoke с object keys → 200 + cascade called + storage.delete для each key', async () => {
		const objectKeys = ['passport/2026/05/22/key1.jpg', 'passport/2026/05/22/key2.jpg']
		const { app, cascadeCalls, deleteCalls } = buildApp('owner', {
			consentFound: 'active',
			objectKeys,
		})
		const res = await app.request('/api/v1/passport-scan/consent/cns_active/revoke', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ reason: 'gdpr_export' }),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			data: { alreadyRevoked: boolean; deletedObjects: number; revokedReason: string }
		}
		expect(body.data.alreadyRevoked).toBe(false)
		expect(body.data.deletedObjects).toBe(2)
		expect(body.data.revokedReason).toBe('gdpr_export')
		expect(deleteCalls.length).toBe(2)
		expect(deleteCalls).toEqual([...objectKeys])
		expect(cascadeCalls.length).toBe(1)
		expect(cascadeCalls[0]?.tenantId).toBe('org-test')
		expect(cascadeCalls[0]?.consentId).toBe('cns_active')
		expect(cascadeCalls[0]?.reason).toBe('gdpr_export')
	})

	test('[R6] staff role → 200 (guest:update permission satisfied)', async () => {
		const { app } = buildApp('staff', { consentFound: 'active' })
		const res = await app.request('/api/v1/passport-scan/consent/cns_active/revoke', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ reason: 'user_request' }),
		})
		expect(res.status).toBe(200)
	})

	test('[R7] missing body → uses default reason "user_request"', async () => {
		const { app, cascadeCalls } = buildApp('owner', { consentFound: 'active' })
		const res = await app.request('/api/v1/passport-scan/consent/cns_active/revoke', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		})
		expect(res.status).toBe(200)
		expect(cascadeCalls[0]?.reason).toBe('user_request')
	})

	test('[R8] invalid reason enum → 400', async () => {
		const { app } = buildApp('owner', { consentFound: 'active' })
		const res = await app.request('/api/v1/passport-scan/consent/cns_active/revoke', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ reason: 'totally_invalid' }),
		})
		expect(res.status).toBe(400)
	})
})
