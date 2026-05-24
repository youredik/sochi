/**
 * Strict route-level tests для POST /guests/:guestId/documents/from-scan.
 *
 * Sprint C+ Senior P0-1 verification — INSERT endpoint that closes dead-code
 * gap (RTBF cascade + DSAR list стали non-vacuous). Per `feedback_critical_fix_
 * test_coverage_canon` — CRITICAL fix MUST have route-level test до commit.
 *
 * Test matrix:
 *   [F1] cross-tenant guestId (guest not in current tenant) → 404
 *   [F2] valid body → 201 с documentId returned
 *   [F3] missing documentNumber → 400 (zod validation)
 *   [F4] invalid citizenshipIso3 (uppercase RUS not allowed) → 400
 *   [F5] invalid photoConsentLogId format (not cns_*) → 400
 *   [F6] invalid identityMethod enum → 400
 *   [F7] documentRepo.createFromScan called с exact mapped fields
 *   [F8] missing required (citizenshipIso3) → 400
 */
import type { MemberRole } from '@horeca/shared'
import { describe, expect, mock, test } from 'bun:test'
import { onError } from '../../errors/on-error.ts'
import { createTestRouter, type TestContext } from '../../tests/setup.ts'
import { createGuestDocumentRoutesInner } from './guest-document.routes.ts'
import type { GuestDocumentRepo } from './guest-document.repo.ts'
import type { GuestRepo } from './guest.repo.ts'

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

function makeStubGuestRepo(): GuestRepo {
	return {
		getById: async (tenantId: string, id: string) => {
			if (id === 'gst-cross-tenant') return null
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub
			return { tenantId, id, firstName: 'Test', lastName: 'Guest' } as any
		},
	} as unknown as GuestRepo
}

interface StubRepoOpts {
	createCalled?: { value: unknown }
}

function makeStubDocumentRepo(opts: StubRepoOpts = {}): GuestDocumentRepo {
	const createFromScan = mock(async (input: unknown) => {
		if (opts.createCalled) opts.createCalled.value = input
		return 'gdoc_stub01'
	})
	return {
		createFromScan,
		insertWithId: mock(async () => 'gdoc_stub01'),
	} as unknown as GuestDocumentRepo
}

function buildApp(role: MemberRole, repoOpts: StubRepoOpts = {}) {
	const guestRepo = makeStubGuestRepo()
	const documentRepo = makeStubDocumentRepo(repoOpts)
	const app = createTestRouter(ctxFor(role)).route(
		'/api/v1',
		createGuestDocumentRoutesInner({ guestRepo, documentRepo }),
	)
	app.onError(onError)
	return app
}

const VALID_BODY = {
	identityMethod: 'passport_paper' as const,
	documentSeries: '4608',
	documentNumber: '123456',
	documentIssuedBy: 'УФМС г. Сочи',
	documentIssuedDate: '2020-03-15',
	documentExpiryDate: null,
	citizenshipIso3: 'rus',
	objectStoragePath: null,
	objectMimeType: null,
	objectSizeBytes: null,
	ocrConfidenceHeuristic: 0.92,
	ocrSource: 'yandex_vision' as const,
	photoConsentLogId: 'cns_01jztest12345abc',
}

describe('guest-document.routes — POST /guests/:guestId/documents/from-scan', () => {
	test('[F1] cross-tenant guestId → 404', async () => {
		const app = buildApp('owner')
		const res = await app.request('/api/v1/guests/gst-cross-tenant/documents/from-scan', {
			method: 'POST',
			body: JSON.stringify(VALID_BODY),
			headers: { 'content-type': 'application/json' },
		})
		expect(res.status).toBe(404)
	})

	test('[F2] valid body → 201 + documentId', async () => {
		const app = buildApp('owner')
		const res = await app.request('/api/v1/guests/gst-1/documents/from-scan', {
			method: 'POST',
			body: JSON.stringify(VALID_BODY),
			headers: { 'content-type': 'application/json' },
		})
		expect(res.status).toBe(201)
		const body = (await res.json()) as { data: { documentId: string } }
		expect(body.data.documentId).toBe('gdoc_stub01')
	})

	test('[F3] missing documentNumber → 400', async () => {
		const app = buildApp('owner')
		const res = await app.request('/api/v1/guests/gst-1/documents/from-scan', {
			method: 'POST',
			body: JSON.stringify({ ...VALID_BODY, documentNumber: '' }),
			headers: { 'content-type': 'application/json' },
		})
		expect(res.status).toBe(400)
	})

	test('[F4] invalid citizenshipIso3 (uppercase) → 400', async () => {
		const app = buildApp('owner')
		const res = await app.request('/api/v1/guests/gst-1/documents/from-scan', {
			method: 'POST',
			body: JSON.stringify({ ...VALID_BODY, citizenshipIso3: 'RUS' }),
			headers: { 'content-type': 'application/json' },
		})
		expect(res.status).toBe(400)
	})

	test('[F5] invalid photoConsentLogId format → 400', async () => {
		const app = buildApp('owner')
		const res = await app.request('/api/v1/guests/gst-1/documents/from-scan', {
			method: 'POST',
			body: JSON.stringify({ ...VALID_BODY, photoConsentLogId: 'bad_format' }),
			headers: { 'content-type': 'application/json' },
		})
		expect(res.status).toBe(400)
	})

	test('[F6] invalid identityMethod enum → 400', async () => {
		const app = buildApp('owner')
		const res = await app.request('/api/v1/guests/gst-1/documents/from-scan', {
			method: 'POST',
			body: JSON.stringify({ ...VALID_BODY, identityMethod: 'mfsoi' }),
			headers: { 'content-type': 'application/json' },
		})
		expect(res.status).toBe(400)
	})

	test('[F7] createFromScan called с exact mapped fields', async () => {
		const captured: { value: unknown } = { value: null }
		const app = buildApp('owner', { createCalled: captured })
		await app.request('/api/v1/guests/gst-1/documents/from-scan', {
			method: 'POST',
			body: JSON.stringify(VALID_BODY),
			headers: { 'content-type': 'application/json' },
		})
		const arg = captured.value as Record<string, unknown>
		expect(arg.tenantId).toBe('org-test')
		expect(arg.guestId).toBe('gst-1')
		expect(arg.documentNumber).toBe('123456')
		expect(arg.documentSeries).toBe('4608')
		expect(arg.citizenshipIso3).toBe('rus')
		expect(arg.photoConsentLogId).toBe('cns_01jztest12345abc')
		expect(arg.identityMethod).toBe('passport_paper')
		expect(arg.createdBy).toBe(FAKE_USER.id)
	})

	test('[F8] missing required citizenshipIso3 → 400', async () => {
		const app = buildApp('owner')
		const body = { ...VALID_BODY } as Partial<typeof VALID_BODY>
		delete body.citizenshipIso3
		const res = await app.request('/api/v1/guests/gst-1/documents/from-scan', {
			method: 'POST',
			body: JSON.stringify(body),
			headers: { 'content-type': 'application/json' },
		})
		expect(res.status).toBe(400)
	})
})
