/**
 * Room repo — YDB integration tests.
 *
 * Business invariants:
 *   1. Tenant isolation absolute; propertyId scoping on listByProperty.
 *   2. UNIQUE(tenantId, propertyId, number) enforced at DB level — create
 *      and update must surface `RoomNumberTakenError`, not a generic 500.
 *   3. Two rooms with the same `number` allowed across different properties
 *      of the same tenant (uniqueness is per-property, not per-tenant).
 *   4. Two rooms with the same `number` allowed across different tenants
 *      (tenant isolation trumps number-uniqueness).
 *   5. Null-patch for `floor` and `notes` (nullable fields).
 *   6. Update preserves id, tenantId, propertyId, createdAt.
 *   7. updatedAt ms precision preserved (Timestamp wrap works).
 *   8. roomTypeId filter in listByProperty is honored.
 *
 * Requires local YDB (docker-compose up ydb).
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { RoomNumberTakenError } from '../../errors/domain.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createRoomRepo } from './room.repo.ts'

// Use real typed IDs so zod input schemas that enforce typeid format pass.
// These are fixture values, not real FK references — room.repo itself does not
// validate parent existence (that is the service-layer's job, covered elsewhere).
const TENANT_A = newId('organization')
const TENANT_B = newId('organization')
const PROP_A1 = newId('property')
const PROP_A2 = newId('property')
const PROP_B1 = newId('property')
const RT_A1_STD = newId('roomType')
const RT_A1_DLX = newId('roomType')
const RT_A2_STD = newId('roomType')
const RT_B1_STD = newId('roomType')

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

describe('room.repo', { tags: ['db'], timeout: 30_000 }, () => {
	let repo: ReturnType<typeof createRoomRepo>
	const createdIds: Array<{ tenantId: string; id: string }> = []

	beforeAll(async () => {
		await setupTestDb()
		repo = createRoomRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const { tenantId, id } of createdIds) {
			await sql`DELETE FROM room WHERE tenantId = ${tenantId} AND id = ${id}`
		}
		await teardownTestDb()
	})

	test('create: persists exact input and defaults (isActive=true, floor/notes nullable)', async () => {
		const input = {
			roomTypeId: RT_A1_STD,
			number: '101',
			floor: 1,
			notes: 'sea view',
		}

		const created = await repo.create(TENANT_A, PROP_A1, RT_A1_STD, input)
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		expect(created.id).toMatch(/^room_[0-9a-z]{26}$/)
		expect(created.tenantId).toBe(TENANT_A)
		expect(created.propertyId).toBe(PROP_A1)
		expect(created.roomTypeId).toBe(RT_A1_STD)
		expect(created.number).toBe('101')
		expect(created.floor).toBe(1)
		expect(created.notes).toBe('sea view')
		expect(created.isActive).toBe(true)
		expect(created.createdAt).toMatch(ISO_DATETIME)
		expect(created.createdAt).toBe(created.updatedAt)

		const fetched = await repo.getById(TENANT_A, created.id)
		expect(fetched).toEqual(created)
	})

	test('create: floor and notes default to null when omitted', async () => {
		const created = await repo.create(TENANT_A, PROP_A1, RT_A1_STD, {
			roomTypeId: RT_A1_STD,
			number: 'null-test-1',
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		expect(created.floor).toBeNull()
		expect(created.notes).toBeNull()
	})

	test('UNIQUE: duplicate number in same property same tenant → RoomNumberTakenError', async () => {
		const first = await repo.create(TENANT_A, PROP_A1, RT_A1_STD, {
			roomTypeId: RT_A1_STD,
			number: 'UNQ-1',
		})
		createdIds.push({ tenantId: TENANT_A, id: first.id })

		await expect(
			repo.create(TENANT_A, PROP_A1, RT_A1_STD, {
				roomTypeId: RT_A1_STD,
				number: 'UNQ-1',
			}),
		).rejects.toBeInstanceOf(RoomNumberTakenError)
	})

	test('UNIQUE: same number allowed across different properties of same tenant', async () => {
		const inA1 = await repo.create(TENANT_A, PROP_A1, RT_A1_STD, {
			roomTypeId: RT_A1_STD,
			number: 'CROSS-1',
		})
		const inA2 = await repo.create(TENANT_A, PROP_A2, RT_A2_STD, {
			roomTypeId: RT_A2_STD,
			number: 'CROSS-1',
		})
		createdIds.push({ tenantId: TENANT_A, id: inA1.id }, { tenantId: TENANT_A, id: inA2.id })
		expect(inA1.id).not.toBe(inA2.id)
		expect(inA1.propertyId).toBe(PROP_A1)
		expect(inA2.propertyId).toBe(PROP_A2)
	})

	test('UNIQUE: same number allowed across different tenants', async () => {
		const a = await repo.create(TENANT_A, PROP_A1, RT_A1_STD, {
			roomTypeId: RT_A1_STD,
			number: 'TEN-1',
		})
		const b = await repo.create(TENANT_B, PROP_B1, RT_B1_STD, {
			roomTypeId: RT_B1_STD,
			number: 'TEN-1',
		})
		createdIds.push({ tenantId: TENANT_A, id: a.id }, { tenantId: TENANT_B, id: b.id })
		expect(a.tenantId).toBe(TENANT_A)
		expect(b.tenantId).toBe(TENANT_B)
	})

	test('UNIQUE: update to a conflicting number in same property surfaces RoomNumberTakenError', async () => {
		const a = await repo.create(TENANT_A, PROP_A1, RT_A1_STD, {
			roomTypeId: RT_A1_STD,
			number: 'SWAP-A',
		})
		const b = await repo.create(TENANT_A, PROP_A1, RT_A1_STD, {
			roomTypeId: RT_A1_STD,
			number: 'SWAP-B',
		})
		createdIds.push({ tenantId: TENANT_A, id: a.id }, { tenantId: TENANT_A, id: b.id })

		await expect(repo.update(TENANT_A, b.id, { number: 'SWAP-A' })).rejects.toBeInstanceOf(
			RoomNumberTakenError,
		)
		// Both rows must still exist with their original numbers.
		expect((await repo.getById(TENANT_A, a.id))?.number).toBe('SWAP-A')
		expect((await repo.getById(TENANT_A, b.id))?.number).toBe('SWAP-B')
	})

	test('UNIQUE: renaming a number to its own current value is a no-op (allowed)', async () => {
		const a = await repo.create(TENANT_A, PROP_A1, RT_A1_STD, {
			roomTypeId: RT_A1_STD,
			number: 'SAME-1',
		})
		createdIds.push({ tenantId: TENANT_A, id: a.id })

		const patched = await repo.update(TENANT_A, a.id, { number: 'SAME-1', notes: 'no conflict' })
		expect(patched?.number).toBe('SAME-1')
		expect(patched?.notes).toBe('no conflict')
	})

	test('UNIQUE: after delete, the freed number can be reused in the same property', async () => {
		const a = await repo.create(TENANT_A, PROP_A1, RT_A1_STD, {
			roomTypeId: RT_A1_STD,
			number: 'REUSE-1',
		})
		// Delete frees the unique constraint.
		expect(await repo.delete(TENANT_A, a.id)).toBe(true)

		const replacement = await repo.create(TENANT_A, PROP_A1, RT_A1_STD, {
			roomTypeId: RT_A1_STD,
			number: 'REUSE-1',
		})
		createdIds.push({ tenantId: TENANT_A, id: replacement.id })
		expect(replacement.id).not.toBe(a.id)
		expect(replacement.number).toBe('REUSE-1')
	})

	test('listByProperty: returns only rows of the given property and tenant', async () => {
		const a1 = await repo.create(TENANT_A, PROP_A1, RT_A1_STD, {
			roomTypeId: RT_A1_STD,
			number: 'LIST-1',
		})
		const a1b = await repo.create(TENANT_A, PROP_A1, RT_A1_DLX, {
			roomTypeId: RT_A1_DLX,
			number: 'LIST-2',
		})
		const a2 = await repo.create(TENANT_A, PROP_A2, RT_A2_STD, {
			roomTypeId: RT_A2_STD,
			number: 'LIST-3',
		})
		const b1 = await repo.create(TENANT_B, PROP_B1, RT_B1_STD, {
			roomTypeId: RT_B1_STD,
			number: 'LIST-4',
		})
		createdIds.push(
			{ tenantId: TENANT_A, id: a1.id },
			{ tenantId: TENANT_A, id: a1b.id },
			{ tenantId: TENANT_A, id: a2.id },
			{ tenantId: TENANT_B, id: b1.id },
		)

		const prop1List = await repo.listByProperty(TENANT_A, PROP_A1, { includeInactive: false })
		const prop1Ids = new Set(prop1List.map((r) => r.id))
		expect(prop1Ids.has(a1.id)).toBe(true)
		expect(prop1Ids.has(a1b.id)).toBe(true)
		expect(prop1Ids.has(a2.id)).toBe(false)
		expect(prop1Ids.has(b1.id)).toBe(false)
		for (const r of prop1List) {
			expect(r.tenantId).toBe(TENANT_A)
			expect(r.propertyId).toBe(PROP_A1)
		}

		// Cross-tenant probe on same propertyId string must return empty.
		const leak = await repo.listByProperty(TENANT_B, PROP_A1, { includeInactive: false })
		expect(leak).toEqual([])
	})

	test('listByProperty: roomTypeId filter narrows results correctly', async () => {
		// Dedicated roomType ids — avoid overlap with other tests in this file.
		const rtAlpha = newId('roomType')
		const rtBeta = newId('roomType')
		const alpha1 = await repo.create(TENANT_A, PROP_A1, rtAlpha, {
			roomTypeId: rtAlpha,
			number: 'RTF-1',
		})
		const alpha2 = await repo.create(TENANT_A, PROP_A1, rtAlpha, {
			roomTypeId: rtAlpha,
			number: 'RTF-2',
		})
		const beta1 = await repo.create(TENANT_A, PROP_A1, rtBeta, {
			roomTypeId: rtBeta,
			number: 'RTF-3',
		})
		createdIds.push(
			{ tenantId: TENANT_A, id: alpha1.id },
			{ tenantId: TENANT_A, id: alpha2.id },
			{ tenantId: TENANT_A, id: beta1.id },
		)

		const alphaList = await repo.listByProperty(TENANT_A, PROP_A1, {
			includeInactive: false,
			roomTypeId: rtAlpha,
		})
		expect(new Set(alphaList.map((r) => r.id))).toEqual(new Set([alpha1.id, alpha2.id]))
		for (const r of alphaList) expect(r.roomTypeId).toBe(rtAlpha)

		const betaList = await repo.listByProperty(TENANT_A, PROP_A1, {
			includeInactive: false,
			roomTypeId: rtBeta,
		})
		expect(new Set(betaList.map((r) => r.id))).toEqual(new Set([beta1.id]))
	})

	test('listByProperty: includeInactive filter works (also combined with roomTypeId)', async () => {
		const active = await repo.create(TENANT_A, PROP_A1, RT_A1_STD, {
			roomTypeId: RT_A1_STD,
			number: 'INACT-1',
		})
		const inactive = await repo.create(TENANT_A, PROP_A1, RT_A1_STD, {
			roomTypeId: RT_A1_STD,
			number: 'INACT-2',
		})
		createdIds.push({ tenantId: TENANT_A, id: active.id }, { tenantId: TENANT_A, id: inactive.id })
		await repo.update(TENANT_A, inactive.id, { isActive: false })

		const onlyActive = await repo.listByProperty(TENANT_A, PROP_A1, { includeInactive: false })
		const onlyActiveIds = new Set(onlyActive.map((r) => r.id))
		expect(onlyActiveIds.has(active.id)).toBe(true)
		expect(onlyActiveIds.has(inactive.id)).toBe(false)
		for (const r of onlyActive) expect(r.isActive).toBe(true)

		const withInactiveByRt = await repo.listByProperty(TENANT_A, PROP_A1, {
			includeInactive: true,
			roomTypeId: RT_A1_STD,
		})
		const combinedIds = new Set(withInactiveByRt.map((r) => r.id))
		expect(combinedIds.has(active.id)).toBe(true)
		expect(combinedIds.has(inactive.id)).toBe(true)
	})

	test('update: null-patch on floor and notes (undefined omits, null clears)', async () => {
		const created = await repo.create(TENANT_A, PROP_A1, RT_A1_STD, {
			roomTypeId: RT_A1_STD,
			number: 'NPAT-1',
			floor: 3,
			notes: 'orig',
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		// Omit both → unchanged.
		const omitted = await repo.update(TENANT_A, created.id, { notes: 'updated-note' })
		expect(omitted?.floor).toBe(3)
		expect(omitted?.notes).toBe('updated-note')

		// null on both → clears both.
		const cleared = await repo.update(TENANT_A, created.id, {
			floor: null,
			notes: null,
		})
		expect(cleared?.floor).toBeNull()
		expect(cleared?.notes).toBeNull()

		const fetched = await repo.getById(TENANT_A, created.id)
		expect(fetched?.floor).toBeNull()
		expect(fetched?.notes).toBeNull()

		// Reset to non-null.
		const reset = await repo.update(TENANT_A, created.id, { floor: -1, notes: 'basement' })
		expect(reset?.floor).toBe(-1)
		expect(reset?.notes).toBe('basement')
	})

	test('update: preserves immutables (id, tenantId, propertyId, createdAt)', async () => {
		const created = await repo.create(TENANT_A, PROP_A1, RT_A1_STD, {
			roomTypeId: RT_A1_STD,
			number: 'IMM-1',
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		const patched = await repo.update(
			TENANT_A,
			created.id,
			{ number: 'IMM-2', roomTypeId: RT_A1_DLX },
			undefined,
		)
		expect(patched).not.toBeNull()
		expect(patched?.id).toBe(created.id)
		expect(patched?.tenantId).toBe(TENANT_A)
		expect(patched?.propertyId).toBe(PROP_A1)
		expect(patched?.createdAt).toBe(created.createdAt)
		expect(patched?.number).toBe('IMM-2')
		expect(patched?.roomTypeId).toBe(RT_A1_DLX)
	})

	test('update: propertyId can be changed via newPropertyId argument (move to different property)', async () => {
		const created = await repo.create(TENANT_A, PROP_A1, RT_A1_STD, {
			roomTypeId: RT_A1_STD,
			number: 'MOVE-1',
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		const moved = await repo.update(TENANT_A, created.id, { roomTypeId: RT_A2_STD }, PROP_A2)
		expect(moved?.propertyId).toBe(PROP_A2)
		expect(moved?.roomTypeId).toBe(RT_A2_STD)
		expect(moved?.id).toBe(created.id)
	})

	test('update: updatedAt strictly monotonic and ms precision preserved on DB roundtrip', async () => {
		const created = await repo.create(TENANT_A, PROP_A1, RT_A1_STD, {
			roomTypeId: RT_A1_STD,
			number: 'TS-1',
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		await new Promise((r) => setTimeout(r, 10))
		const patched = await repo.update(TENANT_A, created.id, { notes: 'time-stamped' })
		expect(new Date(patched!.updatedAt).getTime()).toBeGreaterThan(
			new Date(created.updatedAt).getTime(),
		)
		const fetched = await repo.getById(TENANT_A, created.id)
		expect(fetched?.updatedAt).toBe(patched?.updatedAt)
		expect(fetched?.createdAt).toBe(created.createdAt)
	})

	test('update: on nonexistent row returns null (no UPSERT leak)', async () => {
		const ghost = 'room_00000000000000000000000000'
		const result = await repo.update(TENANT_A, ghost, { number: 'GHOST' })
		expect(result).toBeNull()
		expect(await repo.getById(TENANT_A, ghost)).toBeNull()
	})

	test('tenant isolation: update/delete with wrong tenant are no-ops', async () => {
		const created = await repo.create(TENANT_A, PROP_A1, RT_A1_STD, {
			roomTypeId: RT_A1_STD,
			number: 'TG-1',
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		expect(await repo.update(TENANT_B, created.id, { number: 'HIJACK' })).toBeNull()
		expect(await repo.delete(TENANT_B, created.id)).toBe(false)

		const still = await repo.getById(TENANT_A, created.id)
		expect(still).toEqual(created)
	})

	test('delete: idempotent (first true, second false), id reusable', async () => {
		const created = await repo.create(TENANT_A, PROP_A1, RT_A1_STD, {
			roomTypeId: RT_A1_STD,
			number: 'DEL-1',
		})

		expect(await repo.delete(TENANT_A, created.id)).toBe(true)
		expect(await repo.getById(TENANT_A, created.id)).toBeNull()
		expect(await repo.delete(TENANT_A, created.id)).toBe(false)
	})
})
