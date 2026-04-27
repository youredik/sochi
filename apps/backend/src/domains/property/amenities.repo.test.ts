/**
 * Property amenities repo — YDB integration tests.
 *
 * Strict per `feedback_strict_tests.md`:
 *   1. UPSERT idempotency: same input twice produces ONE row, not two.
 *   2. Update-path preserves `createdAt` (immutable).
 *   3. updatedAt is strictly monotonic on each upsert.
 *   4. setMany is atomic: empty input clears all; partial inputs replace.
 *   5. setMany rejects unknown codes BEFORE any write (defense-in-depth).
 *   6. setMany rejects intra-set duplicates.
 *   7. Cross-tenant probe: write/read/delete with TENANT_A never affects
 *      TENANT_B (single PK column or not — assert positively).
 *   8. Cross-property probe: same tenant, two properties — same amenity
 *      code coexists independently.
 *   9. listByProperty returns ORDER BY amenityCode (deterministic UI).
 *  10. remove: idempotent (returns false on missing), no-op on
 *      non-existent codes.
 *  11. scope is denormalized correctly from the catalog (no caller drift).
 *  12. value invariant — repo accepts what catalog allows; service-layer
 *      tests cover the rejection path (this is repo-only).
 */
import { type AmenityFreePaid, getAmenity } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createAmenitiesRepo } from './amenities.repo.ts'

const RUN_ID = Date.now().toString(36)
const TENANT_A = `org_amen_a_${RUN_ID}`
const TENANT_B = `org_amen_b_${RUN_ID}`
const PROPERTY_A1 = `prop_amen_a1_${RUN_ID}`
const PROPERTY_A2 = `prop_amen_a2_${RUN_ID}`
const PROPERTY_B1 = `prop_amen_b1_${RUN_ID}`
const ACTOR = 'test-actor'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

describe('property.amenities.repo', { tags: ['db'], timeout: 30_000 }, () => {
	let repo: ReturnType<typeof createAmenitiesRepo>

	beforeAll(async () => {
		await setupTestDb()
		repo = createAmenitiesRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		// Clean every property we touched.
		for (const t of [TENANT_A, TENANT_B]) {
			for (const p of [PROPERTY_A1, PROPERTY_A2, PROPERTY_B1]) {
				await sql`DELETE FROM propertyAmenity WHERE tenantId = ${t} AND propertyId = ${p}`
			}
		}
		await teardownTestDb()
	})

	test('[L0] listByProperty empty — returns []', async () => {
		const list = await repo.listByProperty(TENANT_A, PROPERTY_A1)
		expect(list).toEqual([])
	})

	test('[U1] upsert: insert path persists exact input + denormalized scope', async () => {
		const out = await repo.upsert(
			TENANT_A,
			PROPERTY_A1,
			{ amenityCode: 'AMN_RESTAURANT', freePaid: 'paid', value: null },
			ACTOR,
		)
		expect(out.amenityCode).toBe('AMN_RESTAURANT')
		expect(out.scope).toBe('property') // denormalized from catalog
		expect(out.freePaid).toBe('paid')
		expect(out.value).toBeNull()
		expect(out.createdAt).toMatch(ISO)
		expect(out.updatedAt).toMatch(ISO)
		expect(out.createdAt).toBe(out.updatedAt) // first write
	})

	test('[U2] upsert: scope correctly derived for room-scope amenity', async () => {
		const out = await repo.upsert(
			TENANT_A,
			PROPERTY_A1,
			{ amenityCode: 'AMN_VIEW_SEA', freePaid: 'free', value: null },
			ACTOR,
		)
		expect(out.scope).toBe('room')
	})

	test('[U3] upsert idempotent: re-calling with same code produces ONE row, NOT TWO', async () => {
		// Call again — must update existing, not insert a duplicate.
		await repo.upsert(
			TENANT_A,
			PROPERTY_A1,
			{ amenityCode: 'AMN_RESTAURANT', freePaid: 'paid', value: null },
			ACTOR,
		)
		const list = await repo.listByProperty(TENANT_A, PROPERTY_A1)
		const restaurantRows = list.filter((a) => a.amenityCode === 'AMN_RESTAURANT')
		expect(restaurantRows).toHaveLength(1)
	})

	test('[U4] upsert update path: preserves createdAt, updates updatedAt + freePaid', async () => {
		const before = await repo.listByProperty(TENANT_A, PROPERTY_A1)
		const restaurant = before.find((a) => a.amenityCode === 'AMN_RESTAURANT')
		expect(restaurant).toBeDefined()
		const originalCreated = restaurant?.createdAt
		const originalUpdated = restaurant?.updatedAt

		// Sleep ≥1ms to ensure new Date() > original
		await new Promise((r) => setTimeout(r, 5))

		const out = await repo.upsert(
			TENANT_A,
			PROPERTY_A1,
			{ amenityCode: 'AMN_RESTAURANT', freePaid: 'free', value: null }, // freePaid changed
			ACTOR,
		)
		expect(out.createdAt).toBe(originalCreated) // immutable
		expect(out.updatedAt).not.toBe(originalUpdated)
		expect(new Date(out.updatedAt).getTime()).toBeGreaterThan(
			new Date(originalUpdated as string).getTime(),
		)
		expect(out.freePaid).toBe('free') // patched
	})

	test('[U5] upsert: value field roundtrips for value-supporting amenity', async () => {
		const out = await repo.upsert(
			TENANT_A,
			PROPERTY_A1,
			{ amenityCode: 'AMN_TV_FLAT', freePaid: 'free', value: '55' },
			ACTOR,
		)
		expect(out.value).toBe('55')
		expect(out.scope).toBe('room')

		// Re-fetch via list to ensure persistence
		const list = await repo.listByProperty(TENANT_A, PROPERTY_A1)
		const tv = list.find((a) => a.amenityCode === 'AMN_TV_FLAT')
		expect(tv?.value).toBe('55')
	})

	test('[U6] upsert: value can be cleared via explicit null (re-upsert with null)', async () => {
		const out = await repo.upsert(
			TENANT_A,
			PROPERTY_A1,
			{ amenityCode: 'AMN_TV_FLAT', freePaid: 'free', value: null },
			ACTOR,
		)
		expect(out.value).toBeNull()
	})

	test('[U7] upsert: rejects unknown amenity code BEFORE writing', async () => {
		await expect(
			repo.upsert(
				TENANT_A,
				PROPERTY_A1,
				{ amenityCode: 'AMN_DOES_NOT_EXIST', freePaid: 'free', value: null },
				ACTOR,
			),
		).rejects.toThrowError(/Unknown amenity code/)
	})

	test('[L1] listByProperty returns ORDER BY amenityCode (deterministic)', async () => {
		const list = await repo.listByProperty(TENANT_A, PROPERTY_A1)
		const codes = list.map((a) => a.amenityCode)
		const sorted = [...codes].sort()
		expect(codes).toEqual(sorted)
	})

	test('[L2] listByProperty: scope field reflects catalog (no drift)', async () => {
		const list = await repo.listByProperty(TENANT_A, PROPERTY_A1)
		for (const r of list) {
			const def = getAmenity(r.amenityCode)
			expect(def?.scope).toBe(r.scope)
		}
	})

	test('[D1] remove: returns true and deletes row', async () => {
		await repo.upsert(
			TENANT_A,
			PROPERTY_A2,
			{ amenityCode: 'AMN_AC', freePaid: 'free', value: null },
			ACTOR,
		)
		const before = await repo.listByProperty(TENANT_A, PROPERTY_A2)
		expect(before.find((a) => a.amenityCode === 'AMN_AC')).toBeDefined()

		const removed = await repo.remove(TENANT_A, PROPERTY_A2, 'AMN_AC')
		expect(removed).toBe(true)

		const after = await repo.listByProperty(TENANT_A, PROPERTY_A2)
		expect(after.find((a) => a.amenityCode === 'AMN_AC')).toBeUndefined()
	})

	test('[D2] remove: returns false for non-existent code (idempotent)', async () => {
		const removed = await repo.remove(TENANT_A, PROPERTY_A2, 'AMN_DOES_NOT_EXIST')
		expect(removed).toBe(false)
	})

	test('[D3] remove: returns false on second call (already-deleted row)', async () => {
		// AMN_AC was just deleted in D1
		const removed2 = await repo.remove(TENANT_A, PROPERTY_A2, 'AMN_AC')
		expect(removed2).toBe(false)
	})

	test('[SM1] setMany empty: clears all amenities for the property', async () => {
		// Pre: PROPERTY_A1 has multiple amenities from earlier tests.
		const before = await repo.listByProperty(TENANT_A, PROPERTY_A1)
		expect(before.length).toBeGreaterThan(0)

		const out = await repo.setMany(TENANT_A, PROPERTY_A1, [], ACTOR)
		expect(out).toEqual([])

		const after = await repo.listByProperty(TENANT_A, PROPERTY_A1)
		expect(after).toEqual([])
	})

	test('[SM2] setMany: replaces full set atomically', async () => {
		// Seed with one set
		await repo.setMany(
			TENANT_A,
			PROPERTY_A1,
			[
				{ amenityCode: 'AMN_AC', freePaid: 'free', value: null },
				{ amenityCode: 'AMN_RESTAURANT', freePaid: 'paid', value: null },
			],
			ACTOR,
		)

		// Replace with a different set
		const newSet = [
			{ amenityCode: 'AMN_BAR', freePaid: 'paid' as AmenityFreePaid, value: null },
			{ amenityCode: 'AMN_GARDEN', freePaid: 'free' as AmenityFreePaid, value: null },
			{ amenityCode: 'AMN_VIEW_SEA', freePaid: 'free' as AmenityFreePaid, value: null },
		]
		const out = await repo.setMany(TENANT_A, PROPERTY_A1, newSet, ACTOR)
		expect(out).toHaveLength(3)
		const codes = out.map((a) => a.amenityCode)
		expect(codes).toEqual(['AMN_BAR', 'AMN_GARDEN', 'AMN_VIEW_SEA']) // sorted

		// Original set should be GONE
		const list = await repo.listByProperty(TENANT_A, PROPERTY_A1)
		expect(list.find((a) => a.amenityCode === 'AMN_AC')).toBeUndefined()
		expect(list.find((a) => a.amenityCode === 'AMN_RESTAURANT')).toBeUndefined()
	})

	test('[SM3] setMany: rejects unknown amenity code BEFORE any write (defense-in-depth)', async () => {
		const before = await repo.listByProperty(TENANT_A, PROPERTY_A1)
		const beforeCount = before.length

		await expect(
			repo.setMany(
				TENANT_A,
				PROPERTY_A1,
				[
					{ amenityCode: 'AMN_BAR', freePaid: 'paid', value: null },
					{ amenityCode: 'AMN_FAKE', freePaid: 'free', value: null }, // bad
				],
				ACTOR,
			),
		).rejects.toThrowError(/Unknown amenity code: AMN_FAKE/)

		// Verify NOTHING got deleted/inserted
		const after = await repo.listByProperty(TENANT_A, PROPERTY_A1)
		expect(after.length).toBe(beforeCount)
	})

	test('[SM4] setMany: rejects intra-set duplicate codes', async () => {
		await expect(
			repo.setMany(
				TENANT_A,
				PROPERTY_A1,
				[
					{ amenityCode: 'AMN_AC', freePaid: 'free', value: null },
					{ amenityCode: 'AMN_AC', freePaid: 'paid', value: null }, // duplicate
				],
				ACTOR,
			),
		).rejects.toThrowError(/Duplicate amenity code in set: AMN_AC/)
	})

	test('[SM5] setMany: scope denormalized for every row matches catalog', async () => {
		const out = await repo.setMany(
			TENANT_A,
			PROPERTY_A2,
			[
				{ amenityCode: 'AMN_RESTAURANT', freePaid: 'paid', value: null }, // property
				{ amenityCode: 'AMN_VIEW_MOUNTAIN', freePaid: 'free', value: null }, // room
				{ amenityCode: 'AMN_KITCHEN_FULL', freePaid: 'free', value: null }, // room
			],
			ACTOR,
		)
		expect(out.find((a) => a.amenityCode === 'AMN_RESTAURANT')?.scope).toBe('property')
		expect(out.find((a) => a.amenityCode === 'AMN_VIEW_MOUNTAIN')?.scope).toBe('room')
		expect(out.find((a) => a.amenityCode === 'AMN_KITCHEN_FULL')?.scope).toBe('room')
	})

	test('[CT1] cross-tenant: TENANT_A writes do not appear in TENANT_B reads', async () => {
		await repo.setMany(
			TENANT_B,
			PROPERTY_B1,
			[{ amenityCode: 'AMN_AC', freePaid: 'free', value: null }],
			ACTOR,
		)

		// Add to A
		await repo.upsert(
			TENANT_A,
			PROPERTY_A2,
			{ amenityCode: 'AMN_BAR', freePaid: 'paid', value: null },
			ACTOR,
		)

		const aList = await repo.listByProperty(TENANT_A, PROPERTY_A2)
		const bList = await repo.listByProperty(TENANT_B, PROPERTY_B1)
		expect(aList.find((a) => a.amenityCode === 'AMN_BAR')).toBeDefined()
		expect(aList.find((a) => a.amenityCode === 'AMN_AC')).toBeUndefined() // not from A2
		expect(bList.find((a) => a.amenityCode === 'AMN_AC')).toBeDefined()
		expect(bList.find((a) => a.amenityCode === 'AMN_BAR')).toBeUndefined()
	})

	test('[CT2] cross-tenant remove: cannot delete TENANT_B row using TENANT_A scope', async () => {
		// TENANT_B has AMN_AC on PROPERTY_B1 from CT1.
		// Try to "remove" it claiming TENANT_A.
		const result = await repo.remove(TENANT_A, PROPERTY_B1, 'AMN_AC')
		expect(result).toBe(false) // didn't see the row → no-op

		const bList = await repo.listByProperty(TENANT_B, PROPERTY_B1)
		expect(bList.find((a) => a.amenityCode === 'AMN_AC')).toBeDefined() // still there
	})

	test('[CP1] cross-property (same tenant): same amenity coexists on two properties', async () => {
		await repo.setMany(
			TENANT_A,
			PROPERTY_A1,
			[{ amenityCode: 'AMN_FRONT_DESK_24H', freePaid: 'free', value: null }],
			ACTOR,
		)
		await repo.upsert(
			TENANT_A,
			PROPERTY_A2,
			{ amenityCode: 'AMN_FRONT_DESK_24H', freePaid: 'free', value: null },
			ACTOR,
		)

		const a1 = await repo.listByProperty(TENANT_A, PROPERTY_A1)
		const a2 = await repo.listByProperty(TENANT_A, PROPERTY_A2)
		expect(a1.find((a) => a.amenityCode === 'AMN_FRONT_DESK_24H')).toBeDefined()
		expect(a2.find((a) => a.amenityCode === 'AMN_FRONT_DESK_24H')).toBeDefined()
	})

	test('[I1] insert preserves freePaid override (operator paid → free swap)', async () => {
		// AMN_RESTAURANT default is `paid`. Operator overrides to `free`.
		await repo.setMany(TENANT_A, PROPERTY_A1, [], ACTOR) // clear
		const out = await repo.upsert(
			TENANT_A,
			PROPERTY_A1,
			{ amenityCode: 'AMN_RESTAURANT', freePaid: 'free', value: null }, // override default
			ACTOR,
		)
		expect(out.freePaid).toBe('free')
		// Catalog default is unchanged
		expect(getAmenity('AMN_RESTAURANT')?.defaultFreePaid).toBe('paid')
	})
})
