/**
 * Strict integration tests для passportOcrAudit repo (Sprint C, 2026-05-23).
 *
 * Cross-tenant guards + DSAR export shape + RTBF cascade (152-ФЗ ст.20) +
 * findObjectKeysByConsentId. Run against local YDB (docker).
 *
 * Test matrix (per `feedback_strict_tests.md`):
 *   ─── Insert path ─────────────────────────────────────────────
 *     [PA1] insert returns ocra_* prefixed ID
 *     [PA2] insert persists ALL entity fields verbatim (DSAR export-shape)
 *     [PA3] insert null entities → row persists с entities=null reconstructed
 *     [PA4] confidenceHeuristic round-trip как number (not bigint)
 *
 *   ─── DSAR (152-ФЗ ст.14) ─────────────────────────────────────
 *     [PA5] findByGuestId returns scans for given guest ordered DESC by createdAt
 *     [PA6] findByGuestId wrong tenantId → [] (cross-tenant guard)
 *     [PA7] findByGuestId other guest invisible
 *
 *   ─── RTBF cascade (152-ФЗ ст.20) ──────────────────────────────
 *     [PA8] nullifyEntitiesByConsentId scrubs ALL PII fields, audit row remains
 *     [PA9] nullifyEntitiesByConsentId sets entitiesAnonymizedAt timestamp
 *     [PA10] nullifyEntitiesByConsentId wrong tenantId → unchanged
 *
 *   ─── Storage key lookup для compensating delete ───────────────
 *     [PA11] findObjectKeysByConsentId returns ONLY non-null keys
 *     [PA12] findObjectKeysByConsentId wrong tenantId → []
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { getTestSql, setupTestDb, teardownTestDb } from '../../../../tests/db-setup.ts'
import { createPhotoConsentLogRepo } from '../consent/photo-consent-log.repo.ts'
import {
	createPassportOcrAuditRepo,
	type PassportOcrAuditInsert,
} from './passport-ocr-audit.repo.ts'

const SAMPLE_ENTITIES = {
	surname: 'Иванов',
	name: 'Иван',
	middleName: 'Иванович',
	gender: 'male' as const,
	citizenshipIso3: 'rus',
	birthDate: '1990-06-15',
	birthPlace: 'г. Москва',
	documentNumber: '4608 123456',
	issueDate: '2010-06-15',
	expirationDate: null, // RU internal — no expiry
}

function buildInsert(overrides: Partial<PassportOcrAuditInsert>): PassportOcrAuditInsert {
	return {
		tenantId: overrides.tenantId ?? newId('organization'),
		operatorUserId: overrides.operatorUserId ?? newId('user'),
		guestId: overrides.guestId ?? newId('guest'),
		bookingId: null,
		documentId: null,
		inputMimeType: 'image/jpeg',
		inputSizeBytes: 245_000,
		inputObjectKey: 'passport/2026/05/23/abc123.jpg',
		apiEndpoint: 'https://vision.api.cloud.yandex.net/vision/v1/recognize',
		apiModel: 'passport',
		httpStatus: 200,
		latencyMs: 2150,
		entities: SAMPLE_ENTITIES,
		detectedCountryIso3: 'rus',
		isCountryWhitelisted: true,
		apiConfidenceRaw: 0.0,
		confidenceHeuristic: 0.87,
		outcome: 'success',
		rawResponseJson: null,
		photoConsentLogId: null,
		...overrides,
	}
}

describe('passport-ocr-audit.repo (integration)', () => {
	beforeAll(async () => {
		await setupTestDb()
	})

	afterAll(async () => {
		await teardownTestDb()
	})

	test('[PA1] insert returns ocra_* prefixed ID', async () => {
		const repo = createPassportOcrAuditRepo(getTestSql())
		const id = await repo.insert(buildInsert({}))
		expect(id.startsWith('ocra_')).toBe(true)
		expect(id.length).toBeGreaterThan('ocra_'.length)
	})

	test('[PA2] insert persists ALL entity fields verbatim (DSAR export-shape)', async () => {
		const repo = createPassportOcrAuditRepo(getTestSql())
		const tenantId = newId('organization')
		const guestId = newId('guest')
		await repo.insert(buildInsert({ tenantId, guestId }))
		const exports = await repo.findByGuestId(tenantId, guestId)
		expect(exports.length).toBe(1)
		const e = exports[0]
		if (!e) throw new Error('unreachable')
		expect(e.outcome).toBe('success')
		expect(e.apiModel).toBe('passport')
		expect(e.entities?.surname).toBe('Иванов')
		expect(e.entities?.name).toBe('Иван')
		expect(e.entities?.middleName).toBe('Иванович')
		expect(e.entities?.gender).toBe('male')
		expect(e.entities?.citizenshipIso3).toBe('rus')
		expect(e.entities?.birthDate).toBe('1990-06-15')
		expect(e.entities?.birthPlace).toBe('г. Москва')
		expect(e.entities?.documentNumber).toBe('4608 123456')
		expect(e.entities?.issueDate).toBe('2010-06-15')
	})

	test('[PA3] insert null entities → row persists с entities=null reconstructed', async () => {
		const repo = createPassportOcrAuditRepo(getTestSql())
		const tenantId = newId('organization')
		const guestId = newId('guest')
		await repo.insert(
			buildInsert({
				tenantId,
				guestId,
				entities: null,
				outcome: 'api_error',
				detectedCountryIso3: null,
				isCountryWhitelisted: false,
				confidenceHeuristic: null,
			}),
		)
		const exports = await repo.findByGuestId(tenantId, guestId)
		expect(exports.length).toBe(1)
		expect(exports[0]?.entities).toBeNull()
		expect(exports[0]?.outcome).toBe('api_error')
		expect(exports[0]?.confidenceHeuristic).toBeNull()
	})

	test('[PA4] confidenceHeuristic round-trip как number (not bigint)', async () => {
		const repo = createPassportOcrAuditRepo(getTestSql())
		const tenantId = newId('organization')
		const guestId = newId('guest')
		await repo.insert(buildInsert({ tenantId, guestId, confidenceHeuristic: 0.873 }))
		const exports = await repo.findByGuestId(tenantId, guestId)
		expect(typeof exports[0]?.confidenceHeuristic).toBe('number')
		expect(exports[0]?.confidenceHeuristic).toBeCloseTo(0.873, 3)
	})

	test('[PA5] findByGuestId returns scans ordered DESC by createdAt', async () => {
		const repo = createPassportOcrAuditRepo(getTestSql())
		const tenantId = newId('organization')
		const guestId = newId('guest')
		await repo.insert(buildInsert({ tenantId, guestId, outcome: 'low_confidence' }))
		await new Promise((r) => setTimeout(r, 50))
		await repo.insert(buildInsert({ tenantId, guestId, outcome: 'success' }))
		const exports = await repo.findByGuestId(tenantId, guestId)
		expect(exports.length).toBe(2)
		// Newest first (DESC by createdAt)
		expect(exports[0]?.outcome).toBe('success')
		expect(exports[1]?.outcome).toBe('low_confidence')
	})

	test('[PA6] findByGuestId wrong tenantId → [] (cross-tenant guard)', async () => {
		const repo = createPassportOcrAuditRepo(getTestSql())
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const guestId = newId('guest')
		await repo.insert(buildInsert({ tenantId: tenantA, guestId }))
		const exportsB = await repo.findByGuestId(tenantB, guestId)
		expect(exportsB.length).toBe(0)
	})

	test('[PA7] findByGuestId other guest invisible', async () => {
		const repo = createPassportOcrAuditRepo(getTestSql())
		const tenantId = newId('organization')
		const guestA = newId('guest')
		const guestB = newId('guest')
		await repo.insert(buildInsert({ tenantId, guestId: guestA }))
		await repo.insert(buildInsert({ tenantId, guestId: guestB }))
		const exportsA = await repo.findByGuestId(tenantId, guestA)
		expect(exportsA.length).toBe(1)
	})

	test('[PA8] nullifyEntitiesByConsentId scrubs ALL PII, audit row remains', async () => {
		const sql = getTestSql()
		const auditRepo = createPassportOcrAuditRepo(sql)
		const consentRepo = createPhotoConsentLogRepo(sql)
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const consentId = await consentRepo.insert({
			tenantId,
			guestId,
			version: '2026-05-22b',
			scope: 'passport_ocr',
			acceptedAt: new Date(),
			ipAddress: '192.0.2.1',
			userAgent: 'UA',
			textSnapshot: 'snapshot',
			separateConsents: { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true },
		})
		await auditRepo.insert(buildInsert({ tenantId, guestId, photoConsentLogId: consentId }))
		// Verify PII present BEFORE nullify
		const beforeExports = await auditRepo.findByGuestId(tenantId, guestId)
		expect(beforeExports[0]?.entities?.surname).toBe('Иванов')
		// Cascade
		await auditRepo.nullifyEntitiesByConsentId(tenantId, consentId)
		// Row remains, entities scrubbed
		const afterExports = await auditRepo.findByGuestId(tenantId, guestId)
		expect(afterExports.length).toBe(1)
		expect(afterExports[0]?.entities).toBeNull()
	})

	test('[PA9] nullifyEntitiesByConsentId sets entitiesAnonymizedAt timestamp', async () => {
		const sql = getTestSql()
		const auditRepo = createPassportOcrAuditRepo(sql)
		const consentRepo = createPhotoConsentLogRepo(sql)
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const consentId = await consentRepo.insert({
			tenantId,
			guestId,
			version: '2026-05-22b',
			scope: 'passport_ocr',
			acceptedAt: new Date(),
			ipAddress: '192.0.2.2',
			userAgent: 'UA',
			textSnapshot: 'snapshot',
			separateConsents: { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true },
		})
		await auditRepo.insert(buildInsert({ tenantId, guestId, photoConsentLogId: consentId }))
		const beforeMs = Date.now()
		await auditRepo.nullifyEntitiesByConsentId(tenantId, consentId)
		const afterMs = Date.now()
		const exports = await auditRepo.findByGuestId(tenantId, guestId)
		const ts = exports[0]?.entitiesAnonymizedAt?.getTime() ?? 0
		expect(ts).toBeGreaterThanOrEqual(beforeMs - 1000) // ±1s clock skew tolerance
		expect(ts).toBeLessThanOrEqual(afterMs + 1000)
	})

	test('[PA10] nullifyEntitiesByConsentId wrong tenantId → unchanged', async () => {
		const sql = getTestSql()
		const auditRepo = createPassportOcrAuditRepo(sql)
		const consentRepo = createPhotoConsentLogRepo(sql)
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const guestId = newId('guest')
		const consentId = await consentRepo.insert({
			tenantId: tenantA,
			guestId,
			version: '2026-05-22b',
			scope: 'passport_ocr',
			acceptedAt: new Date(),
			ipAddress: '192.0.2.3',
			userAgent: 'UA',
			textSnapshot: 'snapshot',
			separateConsents: { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true },
		})
		await auditRepo.insert(
			buildInsert({ tenantId: tenantA, guestId, photoConsentLogId: consentId }),
		)
		// Cross-tenant attempt
		await auditRepo.nullifyEntitiesByConsentId(tenantB, consentId)
		// Original tenant's data must remain intact
		const exports = await auditRepo.findByGuestId(tenantA, guestId)
		expect(exports[0]?.entities?.surname).toBe('Иванов')
		expect(exports[0]?.entitiesAnonymizedAt).toBeNull()
	})

	test('[PA11] findObjectKeysByConsentId returns ONLY non-null keys', async () => {
		const sql = getTestSql()
		const auditRepo = createPassportOcrAuditRepo(sql)
		const consentRepo = createPhotoConsentLogRepo(sql)
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const consentId = await consentRepo.insert({
			tenantId,
			guestId,
			version: '2026-05-22b',
			scope: 'passport_ocr',
			acceptedAt: new Date(),
			ipAddress: '192.0.2.4',
			userAgent: 'UA',
			textSnapshot: 'snapshot',
			separateConsents: { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true },
		})
		await auditRepo.insert(
			buildInsert({
				tenantId,
				guestId,
				photoConsentLogId: consentId,
				inputObjectKey: 'passport/2026/05/23/key1.jpg',
			}),
		)
		await auditRepo.insert(
			buildInsert({
				tenantId,
				guestId,
				photoConsentLogId: consentId,
				inputObjectKey: 'passport/2026/05/23/key2.jpg',
			}),
		)
		await auditRepo.insert(
			buildInsert({
				tenantId,
				guestId,
				photoConsentLogId: consentId,
				inputObjectKey: null, // storage upload failed
			}),
		)
		const keys = await auditRepo.findObjectKeysByConsentId(tenantId, consentId)
		expect(keys.length).toBe(2)
		expect(keys.every((k) => k.startsWith('passport/'))).toBe(true)
		// Sorting not stable — check membership
		expect(keys.includes('passport/2026/05/23/key1.jpg')).toBe(true)
		expect(keys.includes('passport/2026/05/23/key2.jpg')).toBe(true)
	})

	test('[PA12] findObjectKeysByConsentId wrong tenantId → []', async () => {
		const sql = getTestSql()
		const auditRepo = createPassportOcrAuditRepo(sql)
		const consentRepo = createPhotoConsentLogRepo(sql)
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const guestId = newId('guest')
		const consentId = await consentRepo.insert({
			tenantId: tenantA,
			guestId,
			version: '2026-05-22b',
			scope: 'passport_ocr',
			acceptedAt: new Date(),
			ipAddress: '192.0.2.5',
			userAgent: 'UA',
			textSnapshot: 'snapshot',
			separateConsents: { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true },
		})
		await auditRepo.insert(
			buildInsert({
				tenantId: tenantA,
				guestId,
				photoConsentLogId: consentId,
				inputObjectKey: 'passport/key.jpg',
			}),
		)
		const keysB = await auditRepo.findObjectKeysByConsentId(tenantB, consentId)
		expect(keysB.length).toBe(0)
	})
})
