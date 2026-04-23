/**
 * Activity repo — YDB integration tests.
 *
 * Business invariants (per mandatory pre-test checklist):
 *
 *   Tenant isolation (activity carries tenantId as first PK dim):
 *     [AT1] insert in tenant A, listForRecord in tenant B → empty
 *     [AT2] pre-seeded noise in tenant A, listForRecord in tenant B (same
 *           objectType + recordId) → still empty (row-level isolation)
 *
 *   PK separation (compound PK: tenantId / objectType / recordId / createdAt / id):
 *     [AK1] Same tenant + different objectType + same recordId → independent
 *     [AK2] Same tenant + same objectType + different recordId → independent
 *     [AK3] Same (tenant, objectType, recordId) but different createdAt
 *           (monotonic clock) → both stored, listForRecord returns BOTH ordered
 *
 *   Roundtrip:
 *     [AR1] insert return value matches what listForRecord reads back
 *           (exact deep-equal — catches JSON column drift)
 *     [AR2] diffJson roundtrips complex nested shapes (object + nested array)
 *
 *   Enum coverage:
 *     [AE1] All 4 activityType values persist/read cleanly: 'created',
 *           'fieldChange', 'statusChange', 'deleted'
 *
 *   Ordering:
 *     [AO1] listForRecord returns rows ORDER BY createdAt ASC, id ASC
 *           (deterministic replay for audit UI)
 *
 *   Limit:
 *     [ALM1] listForRecord honors the `limit` parameter
 *
 * Requires local YDB.
 */
import type { ActivityType } from '@horeca/shared'
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createActivityRepo } from './activity.repo.ts'

const TENANT_A = newId('organization')
const TENANT_B = newId('organization')
const USER_A = newId('user')

describe('activity.repo', { tags: ['db'], timeout: 30_000 }, () => {
	let repo: ReturnType<typeof createActivityRepo>
	const createdKeys: Array<{
		tenantId: string
		objectType: string
		recordId: string
		createdAt: string
		id: string
	}> = []

	beforeAll(async () => {
		await setupTestDb()
		repo = createActivityRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const k of createdKeys) {
			await sql`
				DELETE FROM activity
				WHERE tenantId = ${k.tenantId}
					AND objectType = ${k.objectType}
					AND recordId = ${k.recordId}
					AND createdAt = CAST(${k.createdAt} AS Timestamp)
					AND id = ${k.id}
			`
		}
		await teardownTestDb()
	})

	const track = (a: {
		tenantId: string
		objectType: string
		recordId: string
		createdAt: string
		id: string
	}) => createdKeys.push(a)

	// ---------------- Tenant isolation ----------------

	test('[AT1] insert in tenant A, listForRecord in tenant B → empty', async () => {
		const recordId = newId('booking')
		const a = await repo.insert({
			tenantId: TENANT_A,
			objectType: 'booking',
			recordId,
			activityType: 'created',
			actorUserId: USER_A,
			diffJson: { fields: { status: 'confirmed' } },
		})
		track(a)

		const crossTenant = await repo.listForRecord(TENANT_B, 'booking', recordId, 50)
		expect(crossTenant).toEqual([])

		const ownTenant = await repo.listForRecord(TENANT_A, 'booking', recordId, 50)
		expect(ownTenant.map((x) => x.id)).toEqual([a.id])
	})

	test('[AT2] pre-seeded noise in tenant A; list in tenant B (same keys) still empty', async () => {
		const recordId = newId('booking')
		const noise = await repo.insert({
			tenantId: TENANT_A,
			objectType: 'booking',
			recordId,
			activityType: 'fieldChange',
			actorUserId: USER_A,
			diffJson: { field: 'notes', oldValue: null, newValue: 'hi' },
		})
		track(noise)
		expect(await repo.listForRecord(TENANT_B, 'booking', recordId, 50)).toEqual([])
	})

	// ---------------- PK separation ----------------

	test('[AK1] different objectType on same recordId → independent rows', async () => {
		const recordId = newId('booking')
		const bookingAct = await repo.insert({
			tenantId: TENANT_A,
			objectType: 'booking',
			recordId,
			activityType: 'created',
			actorUserId: USER_A,
			diffJson: { from: 'booking' },
		})
		track(bookingAct)
		const propertyAct = await repo.insert({
			tenantId: TENANT_A,
			objectType: 'property',
			recordId,
			activityType: 'created',
			actorUserId: USER_A,
			diffJson: { from: 'property' },
		})
		track(propertyAct)

		const onBooking = await repo.listForRecord(TENANT_A, 'booking', recordId, 50)
		const onProperty = await repo.listForRecord(TENANT_A, 'property', recordId, 50)
		expect(onBooking.map((x) => x.id)).toEqual([bookingAct.id])
		expect(onProperty.map((x) => x.id)).toEqual([propertyAct.id])
	})

	test('[AK2] different recordId on same objectType → independent rows', async () => {
		const rec1 = newId('booking')
		const rec2 = newId('booking')
		const a1 = await repo.insert({
			tenantId: TENANT_A,
			objectType: 'booking',
			recordId: rec1,
			activityType: 'created',
			actorUserId: USER_A,
			diffJson: {},
		})
		track(a1)
		const a2 = await repo.insert({
			tenantId: TENANT_A,
			objectType: 'booking',
			recordId: rec2,
			activityType: 'created',
			actorUserId: USER_A,
			diffJson: {},
		})
		track(a2)
		expect((await repo.listForRecord(TENANT_A, 'booking', rec1, 50)).map((x) => x.id)).toEqual([
			a1.id,
		])
		expect((await repo.listForRecord(TENANT_A, 'booking', rec2, 50)).map((x) => x.id)).toEqual([
			a2.id,
		])
	})

	test('[AK3,AO1] multiple activities on same record: all stored, ordered by createdAt ASC', async () => {
		const recordId = newId('booking')
		const first = await repo.insert({
			tenantId: TENANT_A,
			objectType: 'booking',
			recordId,
			activityType: 'created',
			actorUserId: USER_A,
			diffJson: { step: 1 },
		})
		track(first)
		await new Promise((r) => setTimeout(r, 12))
		const second = await repo.insert({
			tenantId: TENANT_A,
			objectType: 'booking',
			recordId,
			activityType: 'statusChange',
			actorUserId: USER_A,
			diffJson: { step: 2 },
		})
		track(second)
		await new Promise((r) => setTimeout(r, 12))
		const third = await repo.insert({
			tenantId: TENANT_A,
			objectType: 'booking',
			recordId,
			activityType: 'fieldChange',
			actorUserId: USER_A,
			diffJson: { step: 3 },
		})
		track(third)

		const listed = await repo.listForRecord(TENANT_A, 'booking', recordId, 50)
		expect(listed.map((x) => x.id)).toEqual([first.id, second.id, third.id])
		// Monotonic createdAt — critical for audit UI replay.
		for (let i = 1; i < listed.length; i++) {
			const prev = new Date(listed[i - 1]?.createdAt ?? 0).getTime()
			const curr = new Date(listed[i]?.createdAt ?? 0).getTime()
			expect(curr).toBeGreaterThanOrEqual(prev)
		}
	})

	// ---------------- Roundtrip ----------------

	test('[AR1] insert return value deeply matches what listForRecord reads back', async () => {
		const recordId = newId('booking')
		const input = {
			tenantId: TENANT_A,
			objectType: 'booking' as const,
			recordId,
			activityType: 'fieldChange' as ActivityType,
			actorUserId: USER_A,
			diffJson: { field: 'notes', oldValue: null, newValue: 'updated' },
		}
		const inserted = await repo.insert(input)
		track(inserted)
		const [fetched] = await repo.listForRecord(TENANT_A, 'booking', recordId, 1)
		expect(fetched).toEqual(inserted)
	})

	test('[AR2] diffJson roundtrips nested object + array exactly', async () => {
		const recordId = newId('booking')
		const complex = {
			field: 'timeSlices',
			oldValue: null,
			newValue: [
				{ date: '2027-07-01', grossMicros: '5000000000', currency: 'RUB' },
				{ date: '2027-07-02', grossMicros: '5500000000', currency: 'RUB' },
			],
		}
		const a = await repo.insert({
			tenantId: TENANT_A,
			objectType: 'booking',
			recordId,
			activityType: 'fieldChange',
			actorUserId: USER_A,
			diffJson: complex,
		})
		track(a)
		const [fetched] = await repo.listForRecord(TENANT_A, 'booking', recordId, 1)
		expect(fetched?.diffJson).toEqual(complex)
	})

	// ---------------- Enum coverage ----------------

	test('[AE1] every activityType value persists + reads back', async () => {
		const types: ActivityType[] = ['created', 'fieldChange', 'statusChange', 'deleted']
		const recordId = newId('booking')
		const inserts = await Promise.all(
			types.map((t, i) =>
				repo.insert({
					tenantId: TENANT_A,
					objectType: 'booking',
					recordId,
					activityType: t,
					actorUserId: USER_A,
					diffJson: { enum: i },
				}),
			),
		)
		for (const a of inserts) track(a)
		const listed = await repo.listForRecord(TENANT_A, 'booking', recordId, 50)
		const seenTypes = new Set(listed.map((x) => x.activityType))
		for (const t of types) {
			expect(seenTypes.has(t)).toBe(true)
		}
	})

	// ---------------- Limit ----------------

	test('[ALM1] listForRecord honors limit parameter', async () => {
		const recordId = newId('booking')
		for (let i = 0; i < 5; i++) {
			const a = await repo.insert({
				tenantId: TENANT_A,
				objectType: 'booking',
				recordId,
				activityType: 'fieldChange',
				actorUserId: USER_A,
				diffJson: { i },
			})
			track(a)
			// Small sleep so createdAt values differ (ms-precision).
			await new Promise((r) => setTimeout(r, 4))
		}
		const limited = await repo.listForRecord(TENANT_A, 'booking', recordId, 3)
		expect(limited).toHaveLength(3)
	})
})
