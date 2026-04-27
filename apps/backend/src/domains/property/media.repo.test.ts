/**
 * Property media repo — YDB integration tests.
 *
 * Strict per `feedback_strict_tests.md`:
 *   1. Insert: defaults isHero=false, derivedReady=false, exifStripped=false,
 *      sortOrder=0, three nullable text fields default to null.
 *   2. Patch: three-state (undefined keep / null clear / value set) on every
 *      string field.
 *   3. listByProperty: filter by roomTypeId (null vs string), kind, derivedReady.
 *   4. ORDER BY (sortOrder, createdAt) — deterministic gallery rendering.
 *   5. setHeroExclusive: promotes target, demotes ALL others in same scope.
 *   6. setHeroExclusive: room-scope hero independent of property-scope hero.
 *   7. setHeroExclusive: room A hero independent of room B hero.
 *   8. markProcessed: idempotent; flips both `derivedReady` and `exifStripped`.
 *   9. delete: idempotent (false on missing).
 *  10. Cross-tenant isolation absolute.
 *  11. fileSizeBytes bigint roundtrips at boundaries.
 *  12. roomTypeId null roundtrips correctly.
 */
import type { PropertyMediaCreateInput } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createMediaRepo } from './media.repo.ts'

const RUN_ID = Date.now().toString(36)
const TENANT_A = `org_med_a_${RUN_ID}`
const TENANT_B = `org_med_b_${RUN_ID}`
const PROPERTY_A1 = `prop_med_a1_${RUN_ID}`
const PROPERTY_B1 = `prop_med_b1_${RUN_ID}`
const ROOM_A = `rt_med_room_a_${RUN_ID}`
const ROOM_B = `rt_med_room_b_${RUN_ID}`
const ACTOR = 'test-actor'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

const baseInput: PropertyMediaCreateInput = {
	roomTypeId: null,
	kind: 'photo',
	originalKey: 'media-original/x.jpg',
	mimeType: 'image/jpeg',
	widthPx: 4000,
	heightPx: 3000,
	fileSizeBytes: 5_242_880n,
	altRu: 'Описание',
}

describe('property.media.repo', { tags: ['db'], timeout: 30_000 }, () => {
	let repo: ReturnType<typeof createMediaRepo>
	const created: Array<{ tenantId: string; propertyId: string; mediaId: string }> = []

	beforeAll(async () => {
		await setupTestDb()
		repo = createMediaRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const c of created) {
			await sql`DELETE FROM propertyMedia WHERE tenantId = ${c.tenantId} AND propertyId = ${c.propertyId} AND mediaId = ${c.mediaId}`
		}
		await teardownTestDb()
	})

	test('[I1] create: persists exact input + correct defaults', async () => {
		const id = `med_i1_${RUN_ID}`
		const out = await repo.create(TENANT_A, PROPERTY_A1, id, baseInput, ACTOR)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: id })
		expect(out.mediaId).toBe(id)
		expect(out.tenantId).toBe(TENANT_A)
		expect(out.propertyId).toBe(PROPERTY_A1)
		expect(out.roomTypeId).toBeNull()
		expect(out.kind).toBe('photo')
		expect(out.mimeType).toBe('image/jpeg')
		expect(out.widthPx).toBe(4000)
		expect(out.heightPx).toBe(3000)
		expect(out.fileSizeBytes).toBe(5_242_880n)
		// Defaults
		expect(out.isHero).toBe(false)
		expect(out.derivedReady).toBe(false)
		expect(out.exifStripped).toBe(false)
		expect(out.sortOrder).toBe(0)
		expect(out.altRu).toBe('Описание')
		expect(out.altEn).toBeNull()
		expect(out.captionRu).toBeNull()
		expect(out.captionEn).toBeNull()
		expect(out.createdAt).toMatch(ISO)
		expect(out.createdAt).toBe(out.updatedAt)
	})

	test('[I2] create: roundtrip via getById is byte-identical', async () => {
		const id = `med_i2_${RUN_ID}`
		const out = await repo.create(
			TENANT_A,
			PROPERTY_A1,
			id,
			{ ...baseInput, altEn: 'EN alt', captionRu: 'Caption' },
			ACTOR,
		)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: id })
		const fetched = await repo.getById(TENANT_A, PROPERTY_A1, id)
		expect(fetched).toEqual(out)
	})

	test('[I3] roomTypeId roundtrips: null and string', async () => {
		const idNull = `med_rt_null_${RUN_ID}`
		const idRoom = `med_rt_room_${RUN_ID}`
		await repo.create(TENANT_A, PROPERTY_A1, idNull, baseInput, ACTOR)
		await repo.create(TENANT_A, PROPERTY_A1, idRoom, { ...baseInput, roomTypeId: ROOM_A }, ACTOR)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: idNull })
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: idRoom })
		const a = await repo.getById(TENANT_A, PROPERTY_A1, idNull)
		const b = await repo.getById(TENANT_A, PROPERTY_A1, idRoom)
		expect(a?.roomTypeId).toBeNull()
		expect(b?.roomTypeId).toBe(ROOM_A)
	})

	test('[I4] fileSizeBytes bigint at exact 50 MB boundary roundtrips', async () => {
		const id = `med_50mb_${RUN_ID}`
		const out = await repo.create(
			TENANT_A,
			PROPERTY_A1,
			id,
			{ ...baseInput, fileSizeBytes: 50n * 1024n * 1024n },
			ACTOR,
		)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: id })
		const fetched = await repo.getById(TENANT_A, PROPERTY_A1, id)
		expect(fetched?.fileSizeBytes).toBe(50n * 1024n * 1024n)
		expect(typeof fetched?.fileSizeBytes).toBe('bigint')
		expect(out.fileSizeBytes).toBe(50n * 1024n * 1024n)
	})

	test('[L1] listByProperty: ORDER BY sortOrder asc then createdAt asc', async () => {
		const idA = `med_l1_a_${RUN_ID}`
		const idB = `med_l1_b_${RUN_ID}`
		const idC = `med_l1_c_${RUN_ID}`
		await repo.create(TENANT_B, PROPERTY_B1, idA, baseInput, ACTOR)
		await repo.create(TENANT_B, PROPERTY_B1, idB, baseInput, ACTOR)
		await repo.create(TENANT_B, PROPERTY_B1, idC, baseInput, ACTOR)
		created.push({ tenantId: TENANT_B, propertyId: PROPERTY_B1, mediaId: idA })
		created.push({ tenantId: TENANT_B, propertyId: PROPERTY_B1, mediaId: idB })
		created.push({ tenantId: TENANT_B, propertyId: PROPERTY_B1, mediaId: idC })

		// Promote idC to sortOrder=0; idA stays 0; idB stays 0. Tie-breaker: createdAt
		// (so order is A, B, C — by creation). Bump idC sortOrder=10 → goes last.
		await repo.patch(TENANT_B, PROPERTY_B1, idC, { sortOrder: 10 }, ACTOR)
		// Bump idA to sortOrder=5 → A goes between B and C.
		await repo.patch(TENANT_B, PROPERTY_B1, idA, { sortOrder: 5 }, ACTOR)

		const list = await repo.listByProperty(TENANT_B, PROPERTY_B1)
		const ids = list.map((m) => m.mediaId)
		expect(ids).toEqual([idB, idA, idC]) // sortOrder 0, 5, 10
	})

	test('[L2] listByProperty filter: roomTypeId=null shows only property-scope', async () => {
		const idP = `med_l2_p_${RUN_ID}`
		const idR = `med_l2_r_${RUN_ID}`
		await repo.create(TENANT_A, PROPERTY_A1, idP, baseInput, ACTOR)
		await repo.create(TENANT_A, PROPERTY_A1, idR, { ...baseInput, roomTypeId: ROOM_A }, ACTOR)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: idP })
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: idR })

		const propScope = await repo.listByProperty(TENANT_A, PROPERTY_A1, { roomTypeId: null })
		expect(propScope.find((m) => m.mediaId === idP)).toBeDefined()
		expect(propScope.find((m) => m.mediaId === idR)).toBeUndefined()

		const roomScope = await repo.listByProperty(TENANT_A, PROPERTY_A1, { roomTypeId: ROOM_A })
		expect(roomScope.find((m) => m.mediaId === idR)).toBeDefined()
		expect(roomScope.find((m) => m.mediaId === idP)).toBeUndefined()
	})

	test('[L3] listByProperty filter: onlyDerivedReady excludes pending', async () => {
		const idReady = `med_l3_ready_${RUN_ID}`
		const idPending = `med_l3_pending_${RUN_ID}`
		await repo.create(TENANT_A, PROPERTY_A1, idReady, baseInput, ACTOR)
		await repo.create(TENANT_A, PROPERTY_A1, idPending, baseInput, ACTOR)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: idReady })
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: idPending })

		await repo.markProcessed(TENANT_A, PROPERTY_A1, idReady, ACTOR)
		const ready = await repo.listByProperty(TENANT_A, PROPERTY_A1, { onlyDerivedReady: true })
		const allMatching = ready.filter((m) => m.mediaId === idReady || m.mediaId === idPending)
		expect(allMatching).toHaveLength(1)
		expect(allMatching[0]?.mediaId).toBe(idReady)
	})

	test('[P1] patch: three-state semantics on altEn (undefined / null / string)', async () => {
		const id = `med_p1_${RUN_ID}`
		await repo.create(TENANT_A, PROPERTY_A1, id, { ...baseInput, altEn: 'init' }, ACTOR)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: id })

		// undefined → keep
		const r1 = await repo.patch(TENANT_A, PROPERTY_A1, id, { altRu: 'New RU' }, ACTOR)
		expect(r1?.altEn).toBe('init')

		// null → clear
		const r2 = await repo.patch(TENANT_A, PROPERTY_A1, id, { altEn: null }, ACTOR)
		expect(r2?.altEn).toBeNull()

		// string → set
		const r3 = await repo.patch(TENANT_A, PROPERTY_A1, id, { altEn: 'reset' }, ACTOR)
		expect(r3?.altEn).toBe('reset')
	})

	test('[P2] patch: returns null for unknown mediaId', async () => {
		const out = await repo.patch(TENANT_A, PROPERTY_A1, 'med_fake', { altRu: 'X' }, ACTOR)
		expect(out).toBeNull()
	})

	test('[P3] patch: preserves immutable fields (originalKey, dimensions, mimeType)', async () => {
		const id = `med_p3_${RUN_ID}`
		const created1 = await repo.create(TENANT_A, PROPERTY_A1, id, baseInput, ACTOR)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: id })
		const out = await repo.patch(TENANT_A, PROPERTY_A1, id, { altRu: 'Z' }, ACTOR)
		expect(out?.originalKey).toBe(created1.originalKey)
		expect(out?.widthPx).toBe(created1.widthPx)
		expect(out?.heightPx).toBe(created1.heightPx)
		expect(out?.mimeType).toBe(created1.mimeType)
	})

	test('[H1] setHeroExclusive: promotes target + demotes other property-scope hero', async () => {
		const id1 = `med_h1_${RUN_ID}`
		const id2 = `med_h2_${RUN_ID}`
		await repo.create(TENANT_A, PROPERTY_A1, id1, baseInput, ACTOR)
		await repo.create(TENANT_A, PROPERTY_A1, id2, baseInput, ACTOR)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: id1 })
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: id2 })

		const a = await repo.setHeroExclusive(TENANT_A, PROPERTY_A1, id1, ACTOR)
		expect(a?.isHero).toBe(true)

		// Promote id2 — id1 should be demoted
		const b = await repo.setHeroExclusive(TENANT_A, PROPERTY_A1, id2, ACTOR)
		expect(b?.isHero).toBe(true)
		const r1 = await repo.getById(TENANT_A, PROPERTY_A1, id1)
		expect(r1?.isHero).toBe(false)
	})

	test('[H2] setHeroExclusive: room-scope hero independent of property-scope hero', async () => {
		const idProp = `med_h2_prop_${RUN_ID}`
		const idRoom = `med_h2_room_${RUN_ID}`
		await repo.create(TENANT_A, PROPERTY_A1, idProp, baseInput, ACTOR)
		await repo.create(TENANT_A, PROPERTY_A1, idRoom, { ...baseInput, roomTypeId: ROOM_A }, ACTOR)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: idProp })
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: idRoom })

		await repo.setHeroExclusive(TENANT_A, PROPERTY_A1, idProp, ACTOR)
		await repo.setHeroExclusive(TENANT_A, PROPERTY_A1, idRoom, ACTOR)

		// Both should be hero (independent scopes)
		const p = await repo.getById(TENANT_A, PROPERTY_A1, idProp)
		const r = await repo.getById(TENANT_A, PROPERTY_A1, idRoom)
		expect(p?.isHero).toBe(true)
		expect(r?.isHero).toBe(true)
	})

	test('[H3] setHeroExclusive: room A hero independent of room B hero', async () => {
		const idA = `med_h3_a_${RUN_ID}`
		const idB = `med_h3_b_${RUN_ID}`
		await repo.create(TENANT_A, PROPERTY_A1, idA, { ...baseInput, roomTypeId: ROOM_A }, ACTOR)
		await repo.create(TENANT_A, PROPERTY_A1, idB, { ...baseInput, roomTypeId: ROOM_B }, ACTOR)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: idA })
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: idB })

		await repo.setHeroExclusive(TENANT_A, PROPERTY_A1, idA, ACTOR)
		await repo.setHeroExclusive(TENANT_A, PROPERTY_A1, idB, ACTOR)
		const a = await repo.getById(TENANT_A, PROPERTY_A1, idA)
		const b = await repo.getById(TENANT_A, PROPERTY_A1, idB)
		expect(a?.isHero).toBe(true) // ROOM_A hero
		expect(b?.isHero).toBe(true) // ROOM_B hero
	})

	test('[H4] setHeroExclusive: returns null for unknown mediaId', async () => {
		expect(await repo.setHeroExclusive(TENANT_A, PROPERTY_A1, 'med_fake_hero', ACTOR)).toBeNull()
	})

	test('[M1] markProcessed: idempotent, flips both flags', async () => {
		const id = `med_m1_${RUN_ID}`
		const c = await repo.create(TENANT_A, PROPERTY_A1, id, baseInput, ACTOR)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: id })
		expect(c.derivedReady).toBe(false)
		expect(c.exifStripped).toBe(false)

		const r1 = await repo.markProcessed(TENANT_A, PROPERTY_A1, id, ACTOR)
		expect(r1).toBe(true)
		const after = await repo.getById(TENANT_A, PROPERTY_A1, id)
		expect(after?.derivedReady).toBe(true)
		expect(after?.exifStripped).toBe(true)

		// Idempotent
		const r2 = await repo.markProcessed(TENANT_A, PROPERTY_A1, id, ACTOR)
		expect(r2).toBe(true)
	})

	test('[M2] markProcessed: returns false for unknown mediaId', async () => {
		expect(await repo.markProcessed(TENANT_A, PROPERTY_A1, 'med_fake_proc', ACTOR)).toBe(false)
	})

	test('[D1] delete: returns true and removes row', async () => {
		const id = `med_d1_${RUN_ID}`
		await repo.create(TENANT_A, PROPERTY_A1, id, baseInput, ACTOR)
		expect(await repo.getById(TENANT_A, PROPERTY_A1, id)).not.toBeNull()
		expect(await repo.delete(TENANT_A, PROPERTY_A1, id)).toBe(true)
		expect(await repo.getById(TENANT_A, PROPERTY_A1, id)).toBeNull()
	})

	test('[D2] delete: returns false on non-existent row', async () => {
		expect(await repo.delete(TENANT_A, PROPERTY_A1, 'med_fake_del')).toBe(false)
	})

	test('[CT1] cross-tenant: TENANT_A row invisible to TENANT_B', async () => {
		const id = `med_ct1_${RUN_ID}`
		await repo.create(TENANT_A, PROPERTY_A1, id, baseInput, ACTOR)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: id })
		expect(await repo.getById(TENANT_A, PROPERTY_A1, id)).not.toBeNull()
		expect(await repo.getById(TENANT_B, PROPERTY_A1, id)).toBeNull() // wrong tenant
	})

	test('[CT2] cross-tenant: setHeroExclusive does NOT affect other tenants', async () => {
		const idA = `med_ct2_a_${RUN_ID}`
		const idB = `med_ct2_b_${RUN_ID}`
		await repo.create(TENANT_A, PROPERTY_A1, idA, baseInput, ACTOR)
		await repo.create(TENANT_B, PROPERTY_A1, idB, baseInput, ACTOR) // same propertyId but different tenant
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, mediaId: idA })
		created.push({ tenantId: TENANT_B, propertyId: PROPERTY_A1, mediaId: idB })

		await repo.setHeroExclusive(TENANT_A, PROPERTY_A1, idA, ACTOR)
		await repo.setHeroExclusive(TENANT_B, PROPERTY_A1, idB, ACTOR)

		const a = await repo.getById(TENANT_A, PROPERTY_A1, idA)
		const b = await repo.getById(TENANT_B, PROPERTY_A1, idB)
		expect(a?.isHero).toBe(true)
		expect(b?.isHero).toBe(true) // not demoted by A's promote
	})
})
