/**
 * Strict route-level tests для GET /guests/:guestId/passport-data-export.
 *
 * 152-ФЗ ст.14 DSAR endpoint. RBAC + cross-tenant + aggregation + Content-
 * Disposition header. Real-DB tests separately в .db.test.ts files.
 *
 * Test matrix:
 *   [D1] non-existent guestId → 404
 *   [D2] cross-tenant guestId → 404 (guestRepo returns null)
 *   [D3] valid guest с consents + scans → 200 + correct shape
 *   [D4] guest без data → 200 + empty arrays
 *   [D5] Content-Disposition header set с guest-id + date filename
 *   [D6] response includes dataSubjectRights metadata (revokeUrl + retention)
 *   [D7] anonymized scans (entitiesAnonymizedAt set) → entities=null preserved
 *   [D8] staff role → 200 (guest:read permission satisfied)
 *   [D9] body has tenantId + guestId + exportedAt + consents[] + scans[]
 */
import type { MemberRole } from '@horeca/shared'
import { describe, expect, test } from 'bun:test'
import { onError } from '../../../../errors/on-error.ts'
import type { GuestRepo } from '../../../guest/guest.repo.ts'
import { createTestRouter, type TestContext } from '../../../../tests/setup.ts'
import { createPassportDataExportRoutesInner } from './passport-data-export.routes.ts'

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

function makeStubGuestRepo(opts: { guestExists?: boolean } = {}): GuestRepo {
	return {
		// biome-ignore lint/suspicious/noExplicitAny: minimal stub shape
		getById: async (tenantId: string, guestId: string): Promise<any> => {
			if (opts.guestExists === false) return null
			if (guestId === 'gst-cross-tenant') return null
			return { tenantId, id: guestId, firstName: 'Test', lastName: 'Guest' }
		},
	} as unknown as GuestRepo
}

interface StubFactoryOpts {
	consents?: ReadonlyArray<{
		id: string
		version: string
		scope: string
		acceptedAt: Date
		textSnapshot: string | null
		separateConsents: object | null
		revokedAt: Date | null
		revokedReason: string | null
	}>
	scans?: ReadonlyArray<{
		id: string
		createdAt: Date
		outcome: string
		apiModel: string
		entities: object | null
		confidenceHeuristic: number | null
		entitiesAnonymizedAt: Date | null
	}>
}

function makeStubFactory(opts: StubFactoryOpts = {}) {
	return {
		consentRepo: {
			insert: async () => 'cns_stub',
			findById: async () => null,
			findByGuestId: async () => opts.consents ?? [],
			revoke: async () => ({ revoked: true }),
		},
		auditRepo: {
			insert: async () => 'ocra_stub',
			findByGuestId: async () => opts.scans ?? [],
			nullifyEntitiesByConsentId: async () => undefined,
			findObjectKeysByConsentId: async () => [],
		},
		recordConsentAndAuditAtomic: async () => ({ success: true, consentId: 'cns_stub' }),
		cascadeRtbfRevoke: async () => undefined,
	}
}

function buildApp(role: MemberRole, opts: { guestExists?: boolean } & StubFactoryOpts = {}) {
	const guestRepo = makeStubGuestRepo({
		...(opts.guestExists !== undefined ? { guestExists: opts.guestExists } : {}),
	})
	const factory = makeStubFactory({
		...(opts.consents ? { consents: opts.consents } : {}),
		...(opts.scans ? { scans: opts.scans } : {}),
	})
	const app = createTestRouter(ctxFor(role)).route(
		'/api/v1',
		createPassportDataExportRoutesInner({
			// biome-ignore lint/suspicious/noExplicitAny: stub factory shape
			passportScanFactory: factory as any,
			guestRepo,
		}),
	)
	app.onError(onError)
	return app
}

describe('passport-data-export.routes — 152-ФЗ ст.14 DSAR', () => {
	test('[D1] non-existent guestId → 404', async () => {
		const app = buildApp('owner', { guestExists: false })
		const res = await app.request('/api/v1/guests/gst-missing/passport-data-export')
		expect(res.status).toBe(404)
	})

	test('[D2] cross-tenant guestId → 404 (guestRepo guard)', async () => {
		const app = buildApp('owner')
		const res = await app.request('/api/v1/guests/gst-cross-tenant/passport-data-export')
		expect(res.status).toBe(404)
	})

	test('[D3] valid guest с consents + scans → 200 + correct shape', async () => {
		const acceptedAt = new Date('2026-05-22T10:00:00Z')
		const createdAt = new Date('2026-05-22T10:01:00Z')
		const app = buildApp('owner', {
			consents: [
				{
					id: 'cns_1',
					version: '2026-05-22b',
					scope: 'passport_ocr',
					acceptedAt,
					textSnapshot: 'verbatim consent text',
					separateConsents: { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true },
					revokedAt: null,
					revokedReason: null,
				},
			],
			scans: [
				{
					id: 'ocra_1',
					createdAt,
					outcome: 'success',
					apiModel: 'passport',
					entities: { surname: 'Иванов', name: 'Иван' },
					confidenceHeuristic: 0.87,
					entitiesAnonymizedAt: null,
				},
			],
		})
		const res = await app.request('/api/v1/guests/gst-1/passport-data-export')
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			data: {
				exportedAt: string
				guestId: string
				tenantId: string
				consents: ReadonlyArray<{ id: string; textSnapshot: string }>
				scans: ReadonlyArray<{ id: string; outcome: string }>
			}
		}
		expect(body.data.guestId).toBe('gst-1')
		expect(body.data.tenantId).toBe('org-test')
		expect(body.data.consents.length).toBe(1)
		expect(body.data.consents[0]?.id).toBe('cns_1')
		expect(body.data.consents[0]?.textSnapshot).toBe('verbatim consent text')
		expect(body.data.scans.length).toBe(1)
		expect(body.data.scans[0]?.id).toBe('ocra_1')
		expect(body.data.scans[0]?.outcome).toBe('success')
	})

	test('[D4] guest без data → 200 + empty arrays', async () => {
		const app = buildApp('owner')
		const res = await app.request('/api/v1/guests/gst-1/passport-data-export')
		expect(res.status).toBe(200)
		const body = (await res.json()) as { data: { consents: unknown[]; scans: unknown[] } }
		expect(body.data.consents.length).toBe(0)
		expect(body.data.scans.length).toBe(0)
	})

	test('[D5] Content-Disposition header set с guest-id + date filename', async () => {
		const app = buildApp('owner')
		const res = await app.request('/api/v1/guests/gst-1/passport-data-export')
		const disposition = res.headers.get('Content-Disposition') ?? ''
		expect(disposition.startsWith('attachment;')).toBe(true)
		expect(disposition.includes('passport-data-gst-1-')).toBe(true)
		// Date pattern YYYY-MM-DD
		expect(/passport-data-gst-1-\d{4}-\d{2}-\d{2}\.json/.test(disposition)).toBe(true)
	})

	test('[D6] response includes dataSubjectRights metadata', async () => {
		const app = buildApp('owner')
		const res = await app.request('/api/v1/guests/gst-1/passport-data-export')
		const body = (await res.json()) as {
			data: {
				dataSubjectRights: {
					article: string
					revokeUrl: string
					retentionPolicy: Record<string, string>
				}
			}
		}
		expect(body.data.dataSubjectRights.article).toContain('152-ФЗ ст.14')
		expect(body.data.dataSubjectRights.revokeUrl).toContain('/passport-scan/consent/')
		expect(body.data.dataSubjectRights.retentionPolicy.consentLog).toContain('5 лет')
		expect(body.data.dataSubjectRights.retentionPolicy.photoStorage).toContain('90 дней')
	})

	test('[D7] anonymized scans (entitiesAnonymizedAt set) → entities=null preserved', async () => {
		const app = buildApp('owner', {
			scans: [
				{
					id: 'ocra_anon',
					createdAt: new Date('2026-05-22T10:00:00Z'),
					outcome: 'success',
					apiModel: 'passport',
					entities: null, // already nullified by RTBF cascade
					confidenceHeuristic: null,
					entitiesAnonymizedAt: new Date('2026-05-23T10:00:00Z'),
				},
			],
		})
		const res = await app.request('/api/v1/guests/gst-1/passport-data-export')
		const body = (await res.json()) as {
			data: { scans: ReadonlyArray<{ entities: unknown; entitiesAnonymizedAt: string | null }> }
		}
		expect(body.data.scans[0]?.entities).toBeNull()
		expect(body.data.scans[0]?.entitiesAnonymizedAt).toBe('2026-05-23T10:00:00.000Z')
	})

	test('[D8] staff role → 200 (guest:read permission satisfied)', async () => {
		const app = buildApp('staff')
		const res = await app.request('/api/v1/guests/gst-1/passport-data-export')
		expect(res.status).toBe(200)
	})

	test('[D9] response body shape canonical', async () => {
		const app = buildApp('owner')
		const res = await app.request('/api/v1/guests/gst-1/passport-data-export')
		const body = (await res.json()) as { data: Record<string, unknown> }
		const keys = Object.keys(body.data).sort()
		expect(keys).toEqual(
			['consents', 'dataSubjectRights', 'exportedAt', 'guestId', 'scans', 'tenantId'].sort(),
		)
		// exportedAt — ISO 8601
		expect(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(body.data.exportedAt as string),
		).toBe(true)
	})
})
