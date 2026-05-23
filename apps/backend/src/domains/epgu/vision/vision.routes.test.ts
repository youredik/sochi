/**
 * Vision routes — strict tests per `feedback_strict_tests.md`.
 *
 * Pre-done audit (paste-and-fill):
 *   RBAC × 3 ролей:
 *     [V-R1] staff POST scan → 200 (front-desk operator workflow,
 *            guest:update permission granted to staff)
 *     [V-R2] manager POST scan → 200
 *     [V-R3] owner POST scan → 200 + valid response shape
 *
 *   Validation (Zod boundary):
 *     [V-Z1] missing consent152fzAccepted → 400 (152-ФЗ legal gate)
 *     [V-Z2] consent152fzAccepted=false → 400 (literal-true expected)
 *     [V-Z3] empty imageBase64 → 400 (Zod min(1))
 *     [V-Z4] invalid mimeType → 400 (Zod enum)
 *     [V-Z5] base64 decodes to empty bytes → 400 (handler guard)
 */
import type { MemberRole } from '@horeca/shared'
import { describe, expect, test } from 'bun:test'
import { onError } from '../../../errors/on-error.ts'
import type { GuestRepo } from '../../guest/guest.repo.ts'
import type { IdempotencyMiddleware } from '../../../middleware/idempotency.ts'
import { createMockPassportPhotoStorage } from '../passport-scan/storage/passport-photo-storage.ts'
import { createTestRouter, type TestContext } from '../../../tests/setup.ts'
import { createMockRklCheck } from '../rkl/mock-rkl.ts'
import { createMockVisionOcr } from './mock-vision.ts'
import { createVisionRoutesInner } from './vision.routes.ts'

/**
 * Sprint C: passport-scan factory wraps consent + audit + sql.begin atomic write.
 * Test creates stub factory с no-op writes — bypasses real YDB (route-level tests
 * focus на validation/RBAC/status codes; consent+audit invariants tested через
 * separate .db.test.ts files using real YDB).
 */
function makeStubPassportScanFactory(): unknown {
	return {
		consentRepo: {
			insert: async () => 'cns_stub',
			findById: async () => null,
			findByGuestId: async () => [],
			revoke: async () => ({ revoked: true }),
		},
		auditRepo: {
			insert: async () => 'ocra_stub',
			findByGuestId: async () => [],
			nullifyEntitiesByConsentId: async () => undefined,
			findObjectKeysByConsentId: async () => [],
		},
		recordConsentAndAuditAtomic: async () => ({
			success: true,
			consentId: 'cns_stub',
			errName: null,
		}),
		cascadeRtbfRevoke: async () => ({
			revokedAt: new Date('2026-05-23T12:00:00Z'),
			alreadyRevoked: false,
			revokedReason: 'user_request',
			objectKeysToDelete: [],
		}),
		listGuestDocumentsForExport: async () => [],
	}
}

/** Pass-through idempotency middleware — tests не проверяют dedup separately. */
const noopIdempotency = async (_c: unknown, next: () => Promise<void>) => {
	await next()
}

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

/** Stub guest repo — returns guest для valid IDs, null для cross-tenant probe. */
function makeStubGuestRepo(): GuestRepo {
	return {
		getById: async (tenantId: string, id: string) => {
			if (id === 'gst-cross-tenant') return null // adversarial test case
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub shape — only id+tenantId queried by handler
			return { tenantId, id, firstName: 'Test', lastName: 'Guest' } as any
		},
	} as unknown as GuestRepo
}

function buildApp(role: MemberRole) {
	const visionAdapter = createMockVisionOcr()
	const rklAdapter = createMockRklCheck()
	const guestRepo = makeStubGuestRepo()
	const photoStorage = createMockPassportPhotoStorage()
	const passportScanFactory = makeStubPassportScanFactory()
	const app = createTestRouter(ctxFor(role)).route(
		'/api/v1',
		createVisionRoutesInner({
			visionAdapter,
			rklAdapter,
			idempotency: noopIdempotency as unknown as IdempotencyMiddleware,
			guestRepo,
			photoStorage,
			// biome-ignore lint/suspicious/noExplicitAny: stub factory для unit tests — real YDB через .db.test.ts
			passportScanFactory: passportScanFactory as any,
		}),
	)
	app.onError(onError)
	return app
}

// 4-byte JPEG magic header — non-empty payload для passing handler guard.
const SAMPLE_BASE64 = Buffer.from(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])).toString('base64')

describe('vision.routes — RBAC matrix', () => {
	test('[V-R1] staff POST scan → 200 (front-desk operator workflow)', async () => {
		const res = await buildApp('staff').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': `test-${Math.random().toString(36).slice(2)}`,
			},
			body: JSON.stringify({
				imageBase64: SAMPLE_BASE64,
				mimeType: 'image/jpeg',
				consent152fzAccepted: true,
				guestId: 'gst-test',
				consent152fzVersion: '2026-05-22b',
				consent152fzTextSnapshot: 'Test consent text snapshot для тестов Sprint C',
				separateConsents: { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true },
			}),
		})
		expect(res.status).toBe(200)
	})

	test('[V-R2] manager POST scan → 200', async () => {
		const res = await buildApp('manager').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': `test-${Math.random().toString(36).slice(2)}`,
			},
			body: JSON.stringify({
				imageBase64: SAMPLE_BASE64,
				mimeType: 'image/jpeg',
				consent152fzAccepted: true,
				guestId: 'gst-test',
				consent152fzVersion: '2026-05-22b',
				consent152fzTextSnapshot: 'Test consent text snapshot для тестов Sprint C',
				separateConsents: { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true },
			}),
		})
		expect(res.status).toBe(200)
	})

	test('[V-R3] owner POST scan → 200 + valid response shape', async () => {
		const res = await buildApp('owner').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': `test-${Math.random().toString(36).slice(2)}`,
			},
			body: JSON.stringify({
				imageBase64: SAMPLE_BASE64,
				mimeType: 'image/jpeg',
				consent152fzAccepted: true,
				guestId: 'gst-test',
				consent152fzVersion: '2026-05-22b',
				consent152fzTextSnapshot: 'Test consent text snapshot для тестов Sprint C',
				separateConsents: { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true },
			}),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			data: {
				detectedCountryIso3: string | null
				isCountryWhitelisted: boolean
				entities: unknown
				outcome: string
				latencyMs: number
				httpStatus: number
			}
		}
		expect(typeof body.data.outcome).toBe('string')
		expect(typeof body.data.latencyMs).toBe('number')
		expect(typeof body.data.httpStatus).toBe('number')
		expect(body.data.entities).not.toBe(undefined)
	})
})

describe('vision.routes — validation', () => {
	test('[V-Z1] missing consent152fzAccepted → 400 (152-ФЗ legal gate)', async () => {
		const res = await buildApp('owner').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': `test-${Math.random().toString(36).slice(2)}`,
			},
			body: JSON.stringify({
				imageBase64: SAMPLE_BASE64,
				mimeType: 'image/jpeg',
				// no consent152fzAccepted
			}),
		})
		expect(res.status).toBe(400)
	})

	test('[V-Z2] consent152fzAccepted=false → 400 (literal-true expected)', async () => {
		const res = await buildApp('owner').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': `test-${Math.random().toString(36).slice(2)}`,
			},
			body: JSON.stringify({
				imageBase64: SAMPLE_BASE64,
				mimeType: 'image/jpeg',
				consent152fzAccepted: false,
			}),
		})
		expect(res.status).toBe(400)
	})

	test('[V-Z3] empty imageBase64 → 400', async () => {
		const res = await buildApp('owner').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': `test-${Math.random().toString(36).slice(2)}`,
			},
			body: JSON.stringify({
				imageBase64: '',
				mimeType: 'image/jpeg',
				consent152fzAccepted: true,
				guestId: 'gst-test',
				consent152fzVersion: '2026-05-22b',
				consent152fzTextSnapshot: 'Test consent text snapshot для тестов Sprint C',
				separateConsents: { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true },
			}),
		})
		expect(res.status).toBe(400)
	})

	test('[V-Z4] invalid mimeType → 400', async () => {
		const res = await buildApp('owner').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': `test-${Math.random().toString(36).slice(2)}`,
			},
			body: JSON.stringify({
				imageBase64: SAMPLE_BASE64,
				mimeType: 'application/x-something-weird',
				consent152fzAccepted: true,
				guestId: 'gst-test',
				consent152fzVersion: '2026-05-22b',
				consent152fzTextSnapshot: 'Test consent text snapshot для тестов Sprint C',
				separateConsents: { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true },
			}),
		})
		expect(res.status).toBe(400)
	})

	test('[V-Z5] base64 decodes to empty bytes → 400', async () => {
		const res = await buildApp('owner').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': `test-${Math.random().toString(36).slice(2)}`,
			},
			body: JSON.stringify({
				// '=' is valid single base64 char that decodes to empty
				imageBase64: '=',
				mimeType: 'image/jpeg',
				consent152fzAccepted: true,
				guestId: 'gst-test',
				consent152fzVersion: '2026-05-22b',
				consent152fzTextSnapshot: 'Test consent text snapshot для тестов Sprint C',
				separateConsents: { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true },
			}),
		})
		expect(res.status).toBe(400)
	})

	test('[V-Z6] mimeType image/heic → 400 (Vision не поддерживает HEIC)', async () => {
		const res = await buildApp('owner').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': `test-${Math.random().toString(36).slice(2)}`,
			},
			body: JSON.stringify({
				imageBase64: SAMPLE_BASE64,
				mimeType: 'image/heic',
				consent152fzAccepted: true,
				guestId: 'gst-test',
				consent152fzVersion: '2026-05-22b',
				consent152fzTextSnapshot: 'Test consent text snapshot для тестов Sprint C',
				separateConsents: { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true },
			}),
		})
		expect(res.status).toBe(400)
	})
})

describe('vision.routes — identityMethod branching (ПП-1912)', () => {
	test('[V-I1] identityMethod=passport_zagran → 200 (загранпаспорт MRZ flow)', async () => {
		const res = await buildApp('owner').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': `test-${Math.random().toString(36).slice(2)}`,
			},
			body: JSON.stringify({
				imageBase64: SAMPLE_BASE64,
				mimeType: 'image/jpeg',
				identityMethod: 'passport_zagran',
				consent152fzAccepted: true,
				guestId: 'gst-test',
				consent152fzVersion: '2026-05-22b',
				consent152fzTextSnapshot: 'Test consent text snapshot для тестов Sprint C',
				separateConsents: { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true },
			}),
		})
		expect(res.status).toBe(200)
	})

	test('[V-I2] identityMethod=driver_license → 200 (ВУ flow)', async () => {
		const res = await buildApp('owner').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': `test-${Math.random().toString(36).slice(2)}`,
			},
			body: JSON.stringify({
				imageBase64: SAMPLE_BASE64,
				mimeType: 'image/jpeg',
				identityMethod: 'driver_license',
				consent152fzAccepted: true,
				guestId: 'gst-test',
				consent152fzVersion: '2026-05-22b',
				consent152fzTextSnapshot: 'Test consent text snapshot для тестов Sprint C',
				separateConsents: { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true },
			}),
		})
		expect(res.status).toBe(200)
	})

	test('[V-I3] identityMethod=ebs → 400 (не OCR flow)', async () => {
		const res = await buildApp('owner').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': `test-${Math.random().toString(36).slice(2)}`,
			},
			body: JSON.stringify({
				imageBase64: SAMPLE_BASE64,
				mimeType: 'image/jpeg',
				identityMethod: 'ebs',
				consent152fzAccepted: true,
				guestId: 'gst-test',
				consent152fzVersion: '2026-05-22b',
				consent152fzTextSnapshot: 'Test consent text snapshot для тестов Sprint C',
				separateConsents: { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true },
			}),
		})
		expect(res.status).toBe(400)
	})

	test('[V-I4] identityMethod=digital_id_max → 400 (не OCR flow)', async () => {
		const res = await buildApp('owner').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': `test-${Math.random().toString(36).slice(2)}`,
			},
			body: JSON.stringify({
				imageBase64: SAMPLE_BASE64,
				mimeType: 'image/jpeg',
				identityMethod: 'digital_id_max',
				consent152fzAccepted: true,
				guestId: 'gst-test',
				consent152fzVersion: '2026-05-22b',
				consent152fzTextSnapshot: 'Test consent text snapshot для тестов Sprint C',
				separateConsents: { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true },
			}),
		})
		expect(res.status).toBe(400)
	})

	test('[V-I5] missing identityMethod → 200 (default passport_paper, backward compat)', async () => {
		const res = await buildApp('owner').request('/api/v1/passport/scan', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': `test-${Math.random().toString(36).slice(2)}`,
			},
			body: JSON.stringify({
				imageBase64: SAMPLE_BASE64,
				mimeType: 'image/jpeg',
				consent152fzAccepted: true,
				guestId: 'gst-test',
				consent152fzVersion: '2026-05-22b',
				consent152fzTextSnapshot: 'Test consent text snapshot для тестов Sprint C',
				separateConsents: { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true },
			}),
		})
		expect(res.status).toBe(200)
	})
})
