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
import type { Activity, ActivityType } from '@horeca/shared'
import { activityObjectTypeSchema, newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test, jest } from 'bun:test'

jest.setTimeout(60_000)

import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createActivityRepo } from './activity.repo.ts'

const TENANT_A = newId('organization')
const TENANT_B = newId('organization')
const USER_A = newId('user')

describe('activity.repo', () => {
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

	// ============================================================
	//  listRecent — tenant-wide reverse-chrono feed (A.bis.3 / plan §17).
	//  PK is (tenantId, objectType, recordId, createdAt, id); we prefix-scan
	//  the tenant slice then ORDER BY createdAt DESC, id DESC LIMIT N.
	// ============================================================

	test('[ARR1] listRecent — tenant isolation: rows from tenant A do not surface for tenant B', async () => {
		// Use distinct, fresh tenants so the assertion holds regardless of
		// what other tests have inserted into TENANT_A/TENANT_B already.
		const isolatedTenantA = newId('organization')
		const isolatedTenantB = newId('organization')
		const noise = await repo.insert({
			tenantId: isolatedTenantA,
			objectType: 'booking',
			recordId: newId('booking'),
			activityType: 'created',
			actorUserId: USER_A,
			diffJson: { tag: 'tenant-A-only' },
		})
		track(noise)

		const seenByB = await repo.listRecent(isolatedTenantB, 50)
		expect(seenByB).toEqual([])

		const seenByA = await repo.listRecent(isolatedTenantA, 50)
		// At least one row, and zero of them leak into B's view.
		expect(seenByA.length).toBeGreaterThanOrEqual(1)
		expect(seenByA.every((r) => r.tenantId === isolatedTenantA)).toBe(true)
	})

	test('[ARR2] listRecent — DESC order by createdAt (most recent first), then id DESC as tie-break', async () => {
		const tenant = newId('organization')
		const recordId = newId('booking')
		const first = await repo.insert({
			tenantId: tenant,
			objectType: 'booking',
			recordId,
			activityType: 'created',
			actorUserId: USER_A,
			diffJson: { step: 'first' },
		})
		track(first)
		await new Promise((r) => setTimeout(r, 12))
		const second = await repo.insert({
			tenantId: tenant,
			objectType: 'property',
			recordId: newId('property'),
			activityType: 'fieldChange',
			actorUserId: USER_A,
			diffJson: { step: 'second' },
		})
		track(second)
		await new Promise((r) => setTimeout(r, 12))
		const third = await repo.insert({
			tenantId: tenant,
			objectType: 'folio',
			recordId: newId('folio'),
			activityType: 'statusChange',
			actorUserId: USER_A,
			diffJson: { step: 'third' },
		})
		track(third)

		const recent = await repo.listRecent(tenant, 10)
		// Most recent first, oldest last — exact-id sequence.
		expect(recent.map((r) => r.id)).toEqual([third.id, second.id, first.id])
		// Verify monotonic DESC on createdAt for paranoia.
		for (let i = 1; i < recent.length; i++) {
			const prev = new Date(recent[i - 1]?.createdAt ?? 0).getTime()
			const curr = new Date(recent[i]?.createdAt ?? 0).getTime()
			expect(prev).toBeGreaterThanOrEqual(curr)
		}
	})

	test('[ARR3] listRecent — respects limit (lower bound trims most-recent N)', async () => {
		const tenant = newId('organization')
		const ids: string[] = []
		for (let i = 0; i < 5; i++) {
			const a = await repo.insert({
				tenantId: tenant,
				objectType: 'booking',
				recordId: newId('booking'),
				activityType: 'fieldChange',
				actorUserId: USER_A,
				diffJson: { i },
			})
			track(a)
			ids.push(a.id)
			await new Promise((r) => setTimeout(r, 4))
		}
		const limited = await repo.listRecent(tenant, 3)
		expect(limited).toHaveLength(3)
		expect(ids).toHaveLength(5)
		const [, , id2, id3, id4] = ids
		expect(id2).not.toBe(undefined)
		expect(id3).not.toBe(undefined)
		expect(id4).not.toBe(undefined)
		// Latest three inserted (indexes 4, 3, 2 in DESC order).
		expect(limited.map((r) => r.id)).toEqual([id4!, id3!, id2!])
	})

	test('[ARR4] listRecent — empty tenant returns empty array (no zero-row crash)', async () => {
		const empty = newId('organization')
		const recent = await repo.listRecent(empty, 20)
		expect(recent).toEqual([])
	})

	test('[ARR5] listRecent — mixes objectTypes within the tenant (NOT prefix-locked to one type)', async () => {
		const tenant = newId('organization')
		const acts = await Promise.all([
			repo.insert({
				tenantId: tenant,
				objectType: 'booking',
				recordId: newId('booking'),
				activityType: 'created',
				actorUserId: USER_A,
				diffJson: { kind: 'b' },
			}),
			repo.insert({
				tenantId: tenant,
				objectType: 'folio',
				recordId: newId('folio'),
				activityType: 'created',
				actorUserId: USER_A,
				diffJson: { kind: 'f' },
			}),
			repo.insert({
				tenantId: tenant,
				objectType: 'payment',
				recordId: newId('payment'),
				activityType: 'statusChange',
				actorUserId: USER_A,
				diffJson: { kind: 'p' },
			}),
			repo.insert({
				tenantId: tenant,
				objectType: 'notification',
				recordId: newId('notification'),
				activityType: 'manualRetry',
				actorUserId: USER_A,
				diffJson: { kind: 'n' },
			}),
		])
		for (const a of acts) track(a)
		const recent = await repo.listRecent(tenant, 10)
		const seenObjectTypes = new Set(recent.map((r) => r.objectType))
		// All 4 objectTypes surface — listRecent is NOT per-type prefix-scoped.
		expect(seenObjectTypes).toEqual(new Set(['booking', 'folio', 'payment', 'notification']))
	})

	test('[ARR7] listRecent — enum FULL objectType coverage (all 17 types roundtrip via tenant scan)', async () => {
		// `feedback_strict_tests.md` enum FULL coverage: explicitly insert one
		// row per ActivityObjectType value and verify listRecent surfaces ALL 17
		// types within the same tenant. Guards against silent enum-filtering
		// drift (e.g. a future `WHERE objectType IN (...)` regression). Existing
		// AE1 covers roundtrip via insert path для `activityType` enum, but
		// objectType enum FULL was implicit (insert path serves listRecent too,
		// but explicit verification through listRecent's read path closes the
		// strict-canon loop).
		const tenant = newId('organization')
		const allObjectTypes = activityObjectTypeSchema.options // sourced from shared zod schema — auto-grows
		expect(allObjectTypes.length).toBe(17)

		const inserted: Activity[] = []
		for (const objectType of allObjectTypes) {
			const a = await repo.insert({
				tenantId: tenant,
				objectType,
				recordId: newId('booking'), // recordId shape doesn't constrain objectType FK semantics here
				activityType: 'created',
				actorUserId: USER_A,
				diffJson: { objectType },
			})
			track(a)
			inserted.push(a)
			// Tiny gap so createdAt differs for stable DESC order.
			await new Promise((r) => setTimeout(r, 4))
		}

		// listRecent с limit covering all 17 must return every objectType once.
		const recent = await repo.listRecent(tenant, 50)
		expect(recent).toHaveLength(17)
		const seen = new Set(recent.map((r) => r.objectType))
		// Set equality — every enum value present exactly once.
		expect(seen).toEqual(new Set(allObjectTypes))
		// Order: most-recent (last inserted) first.
		expect(recent[0]?.objectType).toBe(allObjectTypes[allObjectTypes.length - 1])
	})

	test('[ARR6] listRecent — exact-shape roundtrip equality (diffJson + actorType + nullable impersonator)', async () => {
		const tenant = newId('organization')
		const inserted = await repo.insert({
			tenantId: tenant,
			objectType: 'booking',
			recordId: newId('booking'),
			activityType: 'fieldChange',
			actorUserId: USER_A,
			actorType: 'system',
			diffJson: { field: 'status', oldValue: 'confirmed', newValue: 'in_house' },
		})
		track(inserted)
		const [fetched] = await repo.listRecent(tenant, 1)
		// Deep-equal: catches JSON-column drift, null-vs-undefined regressions
		// on `impersonatorUserId`, and lossy actorType roundtrip.
		expect(fetched).toEqual(inserted)
		expect(fetched?.actorType).toBe('system')
		expect(fetched?.impersonatorUserId).toBeNull()
	})
})
