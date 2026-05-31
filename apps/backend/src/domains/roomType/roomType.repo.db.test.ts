/**
 * RoomType repo — YDB integration tests.
 *
 * Business invariants:
 *   1. Tenant isolation absolute on get/list/update/delete.
 *   2. Property scoping — listByProperty must not return other properties' rows.
 *   3. Immutables on update: id, tenantId, propertyId, createdAt.
 *   4. Null-patch semantic for `description` and `areaSqm` (the two nullable fields).
 *   5. updatedAt strictly monotonic; ms precision preserved (no Timestamp truncation).
 *   6. Integer defaults: isActive=true, extraBeds starts as input (schema default 0).
 *   7. Update of missing row returns null; no UPSERT leak.
 *   8. **inventoryCount canon (2026-05-16)**: ALL read paths (create,
 *      getById, listByProperty, update) return DERIVED count = COUNT
 *      (active rooms WHERE roomTypeId=X). Stored `roomType.inventoryCount`
 *      column persists onboarding-time planning intent but drifts когда
 *      bulk-rooms admin adds/removes — never read on operator-facing
 *      surfaces. Tests assert derived (0 when no rooms; N when N rooms;
 *      decrements когда room deactivated; matches across all read paths).
 *
 * Requires local YDB (docker-compose up ydb).
 */
import { roomTypeCreateInput } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { NULL_TEXT } from '../../db/ydb-helpers.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createRoomTypeRepo } from './roomType.repo.ts'

const RUN_ID = Date.now().toString(36)
const TENANT_A = `org_test_rt_a_${RUN_ID}`
const TENANT_B = `org_test_rt_b_${RUN_ID}`
const PROP_A1 = `prop_test_a1_${RUN_ID}`
const PROP_A2 = `prop_test_a2_${RUN_ID}`
const PROP_B1 = `prop_test_b1_${RUN_ID}`

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

describe('roomType.repo', () => {
	let repo: ReturnType<typeof createRoomTypeRepo>
	const createdIds: Array<{ tenantId: string; id: string }> = []

	beforeAll(async () => {
		await setupTestDb()
		repo = createRoomTypeRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const { tenantId, id } of createdIds) {
			await sql`DELETE FROM roomType WHERE tenantId = ${tenantId} AND id = ${id}`
		}
		await teardownTestDb()
	})

	test('create: persists exact input, defaults applied, roundtrip equal', async () => {
		const input = {
			name: 'Standard Double',
			description: 'Queen bed, balcony',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 1,
			areaSqm: 22,
			inventoryCount: 10,
		}
		roomTypeCreateInput.parse(input)

		const created = await repo.create(TENANT_A, PROP_A1, input)
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		expect(created.id).toMatch(/^rmt_[0-9a-z]{26}$/)
		expect(created.tenantId).toBe(TENANT_A)
		expect(created.propertyId).toBe(PROP_A1)
		expect(created.name).toBe('Standard Double')
		expect(created.description).toBe('Queen bed, balcony')
		expect(created.maxOccupancy).toBe(2)
		expect(created.baseBeds).toBe(1)
		expect(created.extraBeds).toBe(1)
		expect(created.areaSqm).toBe(22)
		// Per canon (invariant #8): inventoryCount = derived COUNT(active rooms).
		// Brand-new roomType с input.inventoryCount=10 (planning intent), but
		// zero rooms physically exist yet → derived = 0. Input.inventoryCount
		// only drives downstream bulk-rooms creation (in onboarding flow),
		// NOT the read-path response shape.
		expect(created.inventoryCount).toBe(0)
		expect(created.isActive).toBe(true)
		expect(created.createdAt).toMatch(ISO_DATETIME)
		expect(created.createdAt).toBe(created.updatedAt)

		const fetched = await repo.getById(TENANT_A, created.id)
		expect(fetched).toEqual(created)
	})

	test('create: nullable fields (description, areaSqm) default to null when omitted', async () => {
		const created = await repo.create(TENANT_A, PROP_A1, {
			name: 'Minimal',
			maxOccupancy: 1,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: 1,
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		expect(created.description).toBeNull()
		expect(created.areaSqm).toBeNull()

		const fetched = await repo.getById(TENANT_A, created.id)
		expect(fetched?.description).toBeNull()
		expect(fetched?.areaSqm).toBeNull()
	})

	test('create: integer values roundtrip exactly (no bigint leak, no off-by-one)', async () => {
		const created = await repo.create(TENANT_A, PROP_A1, {
			name: 'IntCheck',
			maxOccupancy: 20,
			baseBeds: 10,
			extraBeds: 10,
			areaSqm: 1000,
			inventoryCount: 500,
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		// YDB Int32 columns roundtrip as JS numbers (our rowToRoomType normalizes bigint → number).
		expect(typeof created.maxOccupancy).toBe('number')
		expect(typeof created.baseBeds).toBe('number')
		expect(typeof created.extraBeds).toBe('number')
		expect(typeof created.areaSqm).toBe('number')
		expect(typeof created.inventoryCount).toBe('number')

		expect(created.maxOccupancy).toBe(20)
		expect(created.baseBeds).toBe(10)
		expect(created.extraBeds).toBe(10)
		expect(created.areaSqm).toBe(1000)
		// inventoryCount canon (invariant #8): derived = 0 при absence rooms,
		// regardless of input.inventoryCount=500. 500 was the planning intent
		// for the operator's onboarding wizard; only used to drive bulk-rooms.
		expect(created.inventoryCount).toBe(0)
	})

	test('tenant isolation: getById across tenants returns null', async () => {
		const created = await repo.create(TENANT_A, PROP_A1, {
			name: 'Isolated',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: 1,
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		expect(await repo.getById(TENANT_B, created.id)).toBeNull()
		expect(await repo.getById(TENANT_A, created.id)).not.toBeNull()
	})

	test('property scoping: listByProperty returns only rows of that property (and tenant)', async () => {
		const a1rt1 = await repo.create(TENANT_A, PROP_A1, {
			name: 'A1-RT1',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: 1,
		})
		const a1rt2 = await repo.create(TENANT_A, PROP_A1, {
			name: 'A1-RT2',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: 1,
		})
		const a2rt1 = await repo.create(TENANT_A, PROP_A2, {
			name: 'A2-RT1',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: 1,
		})
		const b1rt1 = await repo.create(TENANT_B, PROP_B1, {
			name: 'B1-RT1',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: 1,
		})
		createdIds.push(
			{ tenantId: TENANT_A, id: a1rt1.id },
			{ tenantId: TENANT_A, id: a1rt2.id },
			{ tenantId: TENANT_A, id: a2rt1.id },
			{ tenantId: TENANT_B, id: b1rt1.id },
		)

		const a1List = await repo.listByProperty(TENANT_A, PROP_A1, { includeInactive: false })
		const a1Ids = new Set(a1List.map((r) => r.id))
		expect(a1Ids.has(a1rt1.id)).toBe(true)
		expect(a1Ids.has(a1rt2.id)).toBe(true)
		expect(a1Ids.has(a2rt1.id)).toBe(false)
		expect(a1Ids.has(b1rt1.id)).toBe(false)
		for (const rt of a1List) {
			expect(rt.tenantId).toBe(TENANT_A)
			expect(rt.propertyId).toBe(PROP_A1)
		}

		// Different property, same tenant.
		const a2List = await repo.listByProperty(TENANT_A, PROP_A2, { includeInactive: false })
		expect(new Set(a2List.map((r) => r.id))).toEqual(new Set([a2rt1.id]))

		// Other tenant's property must be invisible.
		const leak = await repo.listByProperty(TENANT_A, PROP_B1, { includeInactive: false })
		expect(leak).toEqual([])
	})

	test('list: includeInactive filter isolates soft-deactivated rows', async () => {
		const active = await repo.create(TENANT_A, PROP_A1, {
			name: 'ActiveRT',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: 1,
		})
		const willInactive = await repo.create(TENANT_A, PROP_A1, {
			name: 'InactiveRT',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: 1,
		})
		createdIds.push(
			{ tenantId: TENANT_A, id: active.id },
			{ tenantId: TENANT_A, id: willInactive.id },
		)

		await repo.update(TENANT_A, willInactive.id, { isActive: false })

		const activeOnly = await repo.listByProperty(TENANT_A, PROP_A1, { includeInactive: false })
		const activeIds = new Set(activeOnly.map((r) => r.id))
		expect(activeIds.has(active.id)).toBe(true)
		expect(activeIds.has(willInactive.id)).toBe(false)
		for (const rt of activeOnly) expect(rt.isActive).toBe(true)

		const all = await repo.listByProperty(TENANT_A, PROP_A1, { includeInactive: true })
		const allIds = new Set(all.map((r) => r.id))
		expect(allIds.has(active.id)).toBe(true)
		expect(allIds.has(willInactive.id)).toBe(true)
	})

	test('update: preserves immutables (id, tenantId, propertyId, createdAt)', async () => {
		const created = await repo.create(TENANT_A, PROP_A1, {
			name: 'ImmutRT',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: 1,
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		const patched = await repo.update(TENANT_A, created.id, {
			name: 'Renamed',
			maxOccupancy: 4,
		})
		expect(patched).not.toBeNull()
		expect(patched?.id).toBe(created.id)
		expect(patched?.tenantId).toBe(TENANT_A)
		expect(patched?.propertyId).toBe(PROP_A1)
		expect(patched?.createdAt).toBe(created.createdAt)
		expect(patched?.name).toBe('Renamed')
		expect(patched?.maxOccupancy).toBe(4)
	})

	test('update: updatedAt strictly monotonic (ms precision preserved)', async () => {
		const created = await repo.create(TENANT_A, PROP_A1, {
			name: 'TimeRT',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: 1,
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		await new Promise((r) => setTimeout(r, 10))
		const patched = await repo.update(TENANT_A, created.id, { name: 'Time2' })
		expect(new Date(patched!.updatedAt).getTime()).toBeGreaterThan(
			new Date(created.updatedAt).getTime(),
		)
		// And the persisted row matches (no DB truncation).
		const fetched = await repo.getById(TENANT_A, created.id)
		expect(fetched?.updatedAt).toBe(patched?.updatedAt)
	})

	test('update: null-patch semantic on description and areaSqm', async () => {
		const created = await repo.create(TENANT_A, PROP_A1, {
			name: 'NullPatch',
			description: 'initial desc',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			areaSqm: 25,
			inventoryCount: 1,
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })
		expect(created.description).toBe('initial desc')
		expect(created.areaSqm).toBe(25)

		// undefined (omit) → unchanged.
		const omitted = await repo.update(TENANT_A, created.id, { name: 'Renamed' })
		expect(omitted?.description).toBe('initial desc')
		expect(omitted?.areaSqm).toBe(25)

		// null → clears both.
		const cleared = await repo.update(TENANT_A, created.id, {
			description: null,
			areaSqm: null,
		})
		expect(cleared?.description).toBeNull()
		expect(cleared?.areaSqm).toBeNull()

		// Re-fetch to confirm persisted.
		const fetched = await repo.getById(TENANT_A, created.id)
		expect(fetched?.description).toBeNull()
		expect(fetched?.areaSqm).toBeNull()

		// Non-null → restores.
		const reset = await repo.update(TENANT_A, created.id, {
			description: 'second desc',
			areaSqm: 30,
		})
		expect(reset?.description).toBe('second desc')
		expect(reset?.areaSqm).toBe(30)
	})

	test('update: partial patch does not leak other fields', async () => {
		const created = await repo.create(TENANT_A, PROP_A1, {
			name: 'Partial',
			description: 'keep',
			maxOccupancy: 4,
			baseBeds: 2,
			extraBeds: 1,
			areaSqm: 30,
			inventoryCount: 5,
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		const patched = await repo.update(TENANT_A, created.id, { inventoryCount: 8 })
		// inventoryCount canon (invariant #8): derived. Patching the stored
		// field updates the DB row (legacy onboarding-intent column), but
		// the response shape always returns derived count. With zero rooms
		// for this roomType → derived = 0 regardless of patch value.
		expect(patched?.inventoryCount).toBe(0)
		expect(patched?.name).toBe('Partial')
		expect(patched?.description).toBe('keep')
		expect(patched?.maxOccupancy).toBe(4)
		expect(patched?.baseBeds).toBe(2)
		expect(patched?.extraBeds).toBe(1)
		expect(patched?.areaSqm).toBe(30)
		expect(patched?.isActive).toBe(true)
	})

	test('update: on nonexistent row returns null (no UPSERT leak)', async () => {
		const ghost = 'rmt_00000000000000000000000000'
		const result = await repo.update(TENANT_A, ghost, { name: 'ShouldNotExist' })
		expect(result).toBeNull()
		expect(await repo.getById(TENANT_A, ghost)).toBeNull()
	})

	test('tenant isolation: update and delete with wrong tenant are no-ops', async () => {
		const created = await repo.create(TENANT_A, PROP_A1, {
			name: 'TenantGuard',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: 1,
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		expect(await repo.update(TENANT_B, created.id, { name: 'Hijacked' })).toBeNull()
		expect(await repo.delete(TENANT_B, created.id)).toBe(false)

		const still = await repo.getById(TENANT_A, created.id)
		expect(still).toEqual(created)
	})

	test('delete: idempotent — first true, second false', async () => {
		const created = await repo.create(TENANT_A, PROP_A1, {
			name: 'DeleteRT',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: 1,
		})

		expect(await repo.delete(TENANT_A, created.id)).toBe(true)
		expect(await repo.getById(TENANT_A, created.id)).toBeNull()
		expect(await repo.delete(TENANT_A, created.id)).toBe(false)
	})

	// === Invariant #8: inventoryCount derived from active rooms ===
	// Strict tests proving the canon end-to-end. The bug that motivated
	// this fix (2026-05-16): operator's tenant Люкс 1 had 10 actual rooms
	// in DB but UI rendered «1 номер» from stale stored value, masking
	// 9 sellable rooms на shahmatka + guest widget capacity.

	test('inventoryCount: zero rooms → 0 in create/getById/listByProperty/update', async () => {
		const rt = await repo.create(TENANT_A, PROP_A1, {
			name: 'EmptyRT',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: 99, // planning intent — must NOT echo back
		})
		createdIds.push({ tenantId: TENANT_A, id: rt.id })

		expect(rt.inventoryCount).toBe(0)
		expect((await repo.getById(TENANT_A, rt.id))?.inventoryCount).toBe(0)
		const list = await repo.listByProperty(TENANT_A, PROP_A1, { includeInactive: false })
		expect(list.find((r) => r.id === rt.id)?.inventoryCount).toBe(0)
		const patched = await repo.update(TENANT_A, rt.id, { name: 'EmptyRT-v2' })
		expect(patched?.inventoryCount).toBe(0)
	})

	test('inventoryCount: N active rooms → derived = N across all read paths', async () => {
		const sql = getTestSql()
		const rt = await repo.create(TENANT_A, PROP_A1, {
			name: 'CountedRT',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: 1, // intentional mismatch с actual rooms below
		})
		createdIds.push({ tenantId: TENANT_A, id: rt.id })

		// Bulk-insert 7 active rooms через raw SQL (matches admin
		// bulk-rooms admin write path; integration test crosses domain).
		const ts = new Date()
		for (let i = 0; i < 7; i++) {
			const roomId = `room_test_cnt_${RUN_ID}_${i}`
			await sql`
				UPSERT INTO room (
					\`tenantId\`, \`id\`, \`propertyId\`, \`roomTypeId\`, \`number\`,
					\`floor\`, \`isActive\`, \`notes\`, \`createdAt\`, \`updatedAt\`
				) VALUES (
					${TENANT_A}, ${roomId}, ${PROP_A1}, ${rt.id}, ${`9${String(i).padStart(2, '0')}`},
					${1}, ${true}, ${NULL_TEXT}, ${ts}, ${ts}
				)
			`
		}

		expect((await repo.getById(TENANT_A, rt.id))?.inventoryCount).toBe(7)
		const list = await repo.listByProperty(TENANT_A, PROP_A1, { includeInactive: false })
		expect(list.find((r) => r.id === rt.id)?.inventoryCount).toBe(7)
		const patched = await repo.update(TENANT_A, rt.id, { name: 'CountedRT-v2' })
		expect(patched?.inventoryCount).toBe(7)

		// Cleanup rooms
		for (let i = 0; i < 7; i++) {
			const roomId = `room_test_cnt_${RUN_ID}_${i}`
			await sql`DELETE FROM room WHERE tenantId = ${TENANT_A} AND id = ${roomId}`
		}
	})

	test('inventoryCount: inactive rooms excluded from derived count', async () => {
		const sql = getTestSql()
		const rt = await repo.create(TENANT_A, PROP_A1, {
			name: 'PartialRT',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: 5,
		})
		createdIds.push({ tenantId: TENANT_A, id: rt.id })

		const ts = new Date()
		// 3 active + 2 inactive — derived must be 3.
		for (let i = 0; i < 5; i++) {
			const roomId = `room_test_part_${RUN_ID}_${i}`
			const isActive = i < 3
			await sql`
				UPSERT INTO room (
					\`tenantId\`, \`id\`, \`propertyId\`, \`roomTypeId\`, \`number\`,
					\`floor\`, \`isActive\`, \`notes\`, \`createdAt\`, \`updatedAt\`
				) VALUES (
					${TENANT_A}, ${roomId}, ${PROP_A1}, ${rt.id}, ${`8${String(i).padStart(2, '0')}`},
					${1}, ${isActive}, ${NULL_TEXT}, ${ts}, ${ts}
				)
			`
		}

		expect((await repo.getById(TENANT_A, rt.id))?.inventoryCount).toBe(3)

		// Cleanup
		for (let i = 0; i < 5; i++) {
			const roomId = `room_test_part_${RUN_ID}_${i}`
			await sql`DELETE FROM room WHERE tenantId = ${TENANT_A} AND id = ${roomId}`
		}
	})

	test('inventoryCount: tenant isolation — other tenant rooms do NOT leak into count', async () => {
		const sql = getTestSql()
		// TENANT_A roomType
		const rtA = await repo.create(TENANT_A, PROP_A1, {
			name: 'IsolatedCountRT',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: 1,
		})
		createdIds.push({ tenantId: TENANT_A, id: rtA.id })

		const ts = new Date()
		// 2 rooms на TENANT_A — these should count
		for (let i = 0; i < 2; i++) {
			await sql`
				UPSERT INTO room (
					\`tenantId\`, \`id\`, \`propertyId\`, \`roomTypeId\`, \`number\`,
					\`floor\`, \`isActive\`, \`notes\`, \`createdAt\`, \`updatedAt\`
				) VALUES (
					${TENANT_A}, ${`room_test_iso_a_${RUN_ID}_${i}`}, ${PROP_A1}, ${rtA.id},
					${`7${String(i).padStart(2, '0')}`}, ${1}, ${true}, ${NULL_TEXT}, ${ts}, ${ts}
				)
			`
		}
		// 5 rooms на TENANT_B с тем же roomTypeId (adversarial — id collision shouldn't matter)
		for (let i = 0; i < 5; i++) {
			await sql`
				UPSERT INTO room (
					\`tenantId\`, \`id\`, \`propertyId\`, \`roomTypeId\`, \`number\`,
					\`floor\`, \`isActive\`, \`notes\`, \`createdAt\`, \`updatedAt\`
				) VALUES (
					${TENANT_B}, ${`room_test_iso_b_${RUN_ID}_${i}`}, ${PROP_B1}, ${rtA.id},
					${`6${String(i).padStart(2, '0')}`}, ${1}, ${true}, ${NULL_TEXT}, ${ts}, ${ts}
				)
			`
		}

		// TENANT_A perspective: только 2 rooms count (not 7).
		expect((await repo.getById(TENANT_A, rtA.id))?.inventoryCount).toBe(2)

		// Cleanup
		for (let i = 0; i < 2; i++) {
			await sql`DELETE FROM room WHERE tenantId = ${TENANT_A} AND id = ${`room_test_iso_a_${RUN_ID}_${i}`}`
		}
		for (let i = 0; i < 5; i++) {
			await sql`DELETE FROM room WHERE tenantId = ${TENANT_B} AND id = ${`room_test_iso_b_${RUN_ID}_${i}`}`
		}
	})
})
