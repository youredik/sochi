/**
 * guest-document.repo.ts — DB-integration tests against local YDB.
 *
 * **Sprint C+ Senior P0-1 fix verification (2026-05-23d)**: Round 4 had RTBF
 * cascade + DSAR list defensively wired для guestDocument, но NO INSERT path.
 * This test verifies the new `createFromScan` INSERT actually works против
 * real YDB schema (migration 0034 + 0067 ALTERs).
 *
 * Test matrix:
 *   [G1] createFromScan inserts row with all required fields + returns gdoc_* ID
 *   [G2] documentSeries / documentIssuedBy / documentIssuedDate nullable fields persist
 *   [G3] photoConsentLogId NOT NULL — required для RTBF cascade linkage
 *   [G4] tenant-isolation: row visible only by tenantId
 *   [G5] idempotent (same input + reuse newId = UPSERT idempotent flag)
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, jest, test } from 'bun:test'

jest.setTimeout(60_000)

import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createGuestDocumentRepo } from './guest-document.repo.ts'

beforeAll(async () => {
	await setupTestDb()
})

afterAll(async () => {
	await teardownTestDb()
})

function buildInput(
	overrides: Partial<
		Parameters<ReturnType<typeof createGuestDocumentRepo>['createFromScan']>[0]
	> = {},
) {
	const tenantId = newId('organization')
	return {
		tenantId,
		guestId: newId('guest'),
		identityMethod: 'passport_paper' as const,
		documentSeries: '4608',
		documentNumber: '123456',
		documentIssuedBy: 'УФМС г. Сочи',
		documentIssuedDate: '2020-03-15',
		documentExpiryDate: null,
		citizenshipIso3: 'rus',
		objectStoragePath: 'tenant/foo/passport/abc.jpg',
		objectMimeType: 'image/jpeg',
		objectSizeBytes: 234_567,
		ocrConfidenceHeuristic: 0.92,
		ocrSource: 'yandex_vision' as const,
		photoConsentLogId: newId('consent'),
		createdBy: 'usr-test',
		...overrides,
	}
}

describe('guest-document.repo (integration)', () => {
	test('[G1] createFromScan inserts row + returns gdoc_* ID', async () => {
		const repo = createGuestDocumentRepo(getTestSql())
		const input = buildInput()
		const id = await repo.createFromScan(input)
		expect(id).toMatch(/^gdoc_[A-Za-z0-9]+$/)
	})

	test('[G2] nullable fields persist as null когда explicitly null', async () => {
		const sql = getTestSql()
		const repo = createGuestDocumentRepo(sql)
		const tenantId = newId('organization')
		const id = await repo.createFromScan(
			buildInput({
				tenantId,
				documentSeries: null,
				documentIssuedBy: null,
				documentIssuedDate: null,
				documentExpiryDate: null,
				objectStoragePath: null,
				objectMimeType: null,
				objectSizeBytes: null,
				ocrConfidenceHeuristic: null,
			}),
		)
		const [rows = []] = await sql<
			{
				documentSeries: string | null
				documentIssuedBy: string | null
				documentIssuedDate: Date | null
				documentExpiryDate: Date | null
				objectStoragePath: string | null
				objectMimeType: string | null
				objectSizeBytes: bigint | null
				ocrConfidenceHeuristic: number | bigint | null
			}[]
		>`
			SELECT documentSeries, documentIssuedBy, documentIssuedDate, documentExpiryDate,
			       objectStoragePath, objectMimeType, objectSizeBytes, ocrConfidenceHeuristic
			FROM guestDocument
			WHERE tenantId = ${tenantId} AND id = ${id}
		`.idempotent(true)
		// Strict canon (feedback_strict_tests): no toBeDefined — assert exact shape.
		expect(rows.length).toBe(1)
		const row = rows[0]!
		expect(row.documentSeries).toBeNull()
		expect(row.documentIssuedBy).toBeNull()
		expect(row.documentIssuedDate).toBeNull()
		expect(row.documentExpiryDate).toBeNull()
		expect(row.objectStoragePath).toBeNull()
		expect(row.objectMimeType).toBeNull()
		expect(row.objectSizeBytes).toBeNull()
		expect(row.ocrConfidenceHeuristic).toBeNull()
	})

	test('[G3] photoConsentLogId persisted — RTBF cascade linkage works', async () => {
		const sql = getTestSql()
		const repo = createGuestDocumentRepo(sql)
		const tenantId = newId('organization')
		const photoConsentLogId = newId('consent')
		const id = await repo.createFromScan(buildInput({ tenantId, photoConsentLogId }))
		const [rows = []] = await sql<{ photoConsentLogId: string | null }[]>`
			SELECT photoConsentLogId FROM guestDocument
			WHERE tenantId = ${tenantId} AND id = ${id}
		`.idempotent(true)
		expect(rows[0]?.photoConsentLogId).toBe(photoConsentLogId)
	})

	test('[G4] tenant-isolation: row from tenant A invisible to tenant B query', async () => {
		const sql = getTestSql()
		const repo = createGuestDocumentRepo(sql)
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const id = await repo.createFromScan(buildInput({ tenantId: tenantA }))
		const [rowsB = []] = await sql<{ id: string }[]>`
			SELECT id FROM guestDocument
			WHERE tenantId = ${tenantB} AND id = ${id}
			LIMIT 1
		`.idempotent(true)
		expect(rowsB.length).toBe(0)
	})

	test('[G5] explicit ID via insertWithId — idempotent re-call same shape', async () => {
		const sql = getTestSql()
		const repo = createGuestDocumentRepo(sql)
		const id = newId('guestDocument')
		const input = buildInput({ documentSeries: 'X' })
		await repo.insertWithId(id, input)
		// Same UPSERT — should not throw (UPSERT semantics).
		await repo.insertWithId(id, input)
		const [rows = []] = await sql<{ documentSeries: string | null }[]>`
			SELECT documentSeries FROM guestDocument
			WHERE tenantId = ${input.tenantId} AND id = ${id}
		`.idempotent(true)
		expect(rows[0]?.documentSeries).toBe('X')
	})
})
