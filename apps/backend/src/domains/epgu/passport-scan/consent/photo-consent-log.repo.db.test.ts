/**
 * Strict integration tests для photoConsentLog repo (Sprint C, 2026-05-23).
 *
 * Cross-tenant + idempotency + textSnapshot fidelity + separateConsents (152-ФЗ
 * ст.10/ст.11 defensive over-consent) coverage. Run against local YDB (docker).
 *
 * Test matrix (per `feedback_strict_tests.md`):
 *   ─── Insert path ─────────────────────────────────────────────
 *     [PC1] insert returns cns_* prefixed ID
 *     [PC2] insert persists ALL fields verbatim (textSnapshot, separateConsents, IP, UA)
 *     [PC3] inserted row findable via findById
 *     [PC4] insert sets revokedAt=null + revokedReason=null + createdAt≈now
 *
 *   ─── Cross-tenant isolation ──────────────────────────────────
 *     [PC5] findById wrong tenantId → null
 *     [PC6] findByGuestId wrong tenantId → []
 *     [PC7] findByGuestId filters by guestId — другие guests invisible
 *
 *   ─── Revoke (152-ФЗ ст.20 RTBF) ───────────────────────────────
 *     [PC8] revoke sets revokedAt + revokedReason verbatim
 *     [PC9] revoke idempotent — already revoked row unchanged (revokedAt preserved)
 *     [PC10] revoke wrong tenantId → row unchanged (cross-tenant guard)
 *
 *   ─── Stored data fidelity ─────────────────────────────────────
 *     [PC11] textSnapshot verbatim — multi-paragraph + special chars preserved
 *     [PC12] separateConsents JSON deserialized с same boolean keys
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { getTestSql, setupTestDb, teardownTestDb } from '../../../../tests/db-setup.ts'
import { createPhotoConsentLogRepo, type PhotoConsentLogInsert } from './photo-consent-log.repo.ts'

const SAMPLE_TEXT_SNAPSHOT = `
В соответствии с Федеральным законом от 27.07.2006 № 152-ФЗ «О персональных данных»
(в редакции от 24.06.2025, ст. 156-ФЗ) даю отдельное согласие на обработку моих
персональных данных. Версия документа: 2026-05-22b.
`.trim()

function buildInsert(overrides: Partial<PhotoConsentLogInsert>): PhotoConsentLogInsert {
	return {
		tenantId: overrides.tenantId ?? newId('organization'),
		guestId: overrides.guestId ?? newId('guest'),
		version: '2026-05-22b',
		scope: 'passport_ocr',
		acceptedAt: new Date('2026-05-23T10:30:00Z'),
		ipAddress: '192.0.2.10',
		userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)',
		textSnapshot: SAMPLE_TEXT_SNAPSHOT,
		separateConsents: {
			generalPdn: true,
			citizenshipSpecial: true,
			biometricPhoto: true,
		},
		...overrides,
	}
}

describe('photo-consent-log.repo (integration)', () => {
	beforeAll(async () => {
		await setupTestDb()
	})

	afterAll(async () => {
		await teardownTestDb()
	})

	test('[PC1] insert returns cns_* prefixed ID', async () => {
		const repo = createPhotoConsentLogRepo(getTestSql())
		const id = await repo.insert(buildInsert({}))
		expect(id.startsWith('cns_')).toBe(true)
		expect(id.length).toBeGreaterThan('cns_'.length)
	})

	test('[PC2] insert persists ALL fields verbatim', async () => {
		const repo = createPhotoConsentLogRepo(getTestSql())
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const insert = buildInsert({ tenantId, guestId })
		const id = await repo.insert(insert)
		const row = await repo.findById(tenantId, id)
		expect(row).not.toBeNull()
		if (row === null) throw new Error('unreachable')
		expect(row.tenantId).toBe(tenantId)
		expect(row.guestId).toBe(guestId)
		expect(row.version).toBe(insert.version)
		expect(row.scope).toBe(insert.scope)
		expect(row.ipAddress).toBe(insert.ipAddress)
		expect(row.userAgent).toBe(insert.userAgent)
		expect(row.acceptedAt.toISOString()).toBe(insert.acceptedAt.toISOString())
		expect(row.textSnapshot).toBe(insert.textSnapshot)
	})

	test('[PC3] inserted row findable via findById', async () => {
		const repo = createPhotoConsentLogRepo(getTestSql())
		const tenantId = newId('organization')
		const id = await repo.insert(buildInsert({ tenantId }))
		const row = await repo.findById(tenantId, id)
		expect(row?.id).toBe(id)
	})

	test('[PC4] insert sets revokedAt=null + revokedReason=null', async () => {
		const repo = createPhotoConsentLogRepo(getTestSql())
		const tenantId = newId('organization')
		const id = await repo.insert(buildInsert({ tenantId }))
		const row = await repo.findById(tenantId, id)
		expect(row?.revokedAt).toBeNull()
		expect(row?.revokedReason).toBeNull()
		// createdAt should be within last 60 seconds of test execution
		const createdMs = row?.createdAt?.getTime() ?? 0
		const nowMs = Date.now()
		expect(nowMs - createdMs).toBeLessThan(60_000)
		expect(nowMs - createdMs).toBeGreaterThanOrEqual(0)
	})

	test('[PC5] findById wrong tenantId → null', async () => {
		const repo = createPhotoConsentLogRepo(getTestSql())
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const id = await repo.insert(buildInsert({ tenantId: tenantA }))
		const rowB = await repo.findById(tenantB, id)
		expect(rowB).toBeNull()
	})

	test('[PC6] findByGuestId wrong tenantId → []', async () => {
		const repo = createPhotoConsentLogRepo(getTestSql())
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const guestId = newId('guest')
		await repo.insert(buildInsert({ tenantId: tenantA, guestId }))
		const rowsB = await repo.findByGuestId(tenantB, guestId)
		expect(rowsB.length).toBe(0)
	})

	test('[PC7] findByGuestId filters by guestId', async () => {
		const repo = createPhotoConsentLogRepo(getTestSql())
		const tenantId = newId('organization')
		const guestA = newId('guest')
		const guestB = newId('guest')
		await repo.insert(buildInsert({ tenantId, guestId: guestA }))
		await repo.insert(buildInsert({ tenantId, guestId: guestB }))
		await repo.insert(buildInsert({ tenantId, guestId: guestA }))
		const rowsA = await repo.findByGuestId(tenantId, guestA)
		expect(rowsA.length).toBe(2)
		expect(rowsA.every((r) => r.guestId === guestA)).toBe(true)
	})

	test('[PC8] revoke sets revokedAt + revokedReason verbatim', async () => {
		const repo = createPhotoConsentLogRepo(getTestSql())
		const tenantId = newId('organization')
		const id = await repo.insert(buildInsert({ tenantId }))
		await repo.revoke(tenantId, id, 'guest_request_ст_20')
		const row = await repo.findById(tenantId, id)
		expect(row?.revokedAt).not.toBeNull()
		expect(row?.revokedReason).toBe('guest_request_ст_20')
	})

	test('[PC9] revoke idempotent — already revoked row unchanged', async () => {
		const repo = createPhotoConsentLogRepo(getTestSql())
		const tenantId = newId('organization')
		const id = await repo.insert(buildInsert({ tenantId }))
		await repo.revoke(tenantId, id, 'first_reason')
		const firstRevokedAt = (await repo.findById(tenantId, id))?.revokedAt
		// Second revoke с другим reason — should NOT overwrite (WHERE revokedAt IS NULL guard)
		await repo.revoke(tenantId, id, 'second_reason')
		const row = await repo.findById(tenantId, id)
		expect(row?.revokedReason).toBe('first_reason')
		expect(row?.revokedAt?.toISOString()).toBe(firstRevokedAt?.toISOString() ?? '')
	})

	test('[PC10] revoke wrong tenantId → row unchanged', async () => {
		const repo = createPhotoConsentLogRepo(getTestSql())
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const id = await repo.insert(buildInsert({ tenantId: tenantA }))
		await repo.revoke(tenantB, id, 'cross_tenant_attempt')
		const rowA = await repo.findById(tenantA, id)
		expect(rowA?.revokedAt).toBeNull()
		expect(rowA?.revokedReason).toBeNull()
	})

	test('[PC11] textSnapshot verbatim — multi-paragraph + special chars preserved', async () => {
		const repo = createPhotoConsentLogRepo(getTestSql())
		const tenantId = newId('organization')
		const trickySnapshot = `Параграф 1\n\nПараграф 2 — содержит «кавычки», тире и ☑ символы.\nLine 3 — line break sanity.`
		const id = await repo.insert(buildInsert({ tenantId, textSnapshot: trickySnapshot }))
		const row = await repo.findById(tenantId, id)
		expect(row?.textSnapshot).toBe(trickySnapshot)
	})

	test('[PC12] separateConsents JSON deserialized с same boolean keys', async () => {
		const repo = createPhotoConsentLogRepo(getTestSql())
		const tenantId = newId('organization')
		const id = await repo.insert(
			buildInsert({
				tenantId,
				separateConsents: {
					generalPdn: true,
					citizenshipSpecial: true,
					biometricPhoto: true,
				},
			}),
		)
		const row = await repo.findById(tenantId, id)
		expect(row?.separateConsents?.generalPdn).toBe(true)
		expect(row?.separateConsents?.citizenshipSpecial).toBe(true)
		expect(row?.separateConsents?.biometricPhoto).toBe(true)
	})
})
