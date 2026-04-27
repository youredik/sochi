/**
 * Property addons repo — YDB integration tests.
 *
 * Strict per `feedback_strict_tests.md`:
 *   1. Insert: every field roundtrips byte-exact (priceMicros bigint,
 *      vatBps int, dailyCapacity nullable Int32, seasonalTags JSON array).
 *   2. Patch: three-state semantics on every nullable field.
 *   3. Patch preserves immutable fields (createdAt).
 *   4. listByProperty filters: category, onlyActive.
 *   5. ORDER BY (sortOrder, code) deterministic.
 *   6. existsByCode for service-layer uniqueness guard.
 *   7. delete idempotent.
 *   8. Cross-tenant isolation absolute.
 *   9. Cross-property isolation: same tenant, two properties — same code coexists.
 *  10. Adversarial seasonalTagsJson corruption raises descriptive error.
 *  11. dailyCapacity null + value roundtrips correctly.
 *  12. priceMicros at MAX_SAFE_INTEGER+1 boundary roundtrips exactly.
 */
import type { AddonCreateInput } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createAddonsRepo } from './addons.repo.ts'

const RUN_ID = Date.now().toString(36)
const TENANT_A = `org_addon_a_${RUN_ID}`
const TENANT_B = `org_addon_b_${RUN_ID}`
const PROPERTY_A1 = `prop_addon_a1_${RUN_ID}`
const PROPERTY_A2 = `prop_addon_a2_${RUN_ID}`
const PROPERTY_B1 = `prop_addon_b1_${RUN_ID}`
const ACTOR = 'test-actor'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

const breakfastInput: AddonCreateInput = {
	code: 'BREAKFAST',
	category: 'FOOD_AND_BEVERAGES',
	nameRu: 'Завтрак',
	pricingUnit: 'PER_NIGHT_PER_PERSON',
	priceMicros: 800_000_000n,
	currency: 'RUB',
	vatBps: 0,
	isActive: true,
	isMandatory: false,
	inventoryMode: 'NONE',
	seasonalTags: [],
	sortOrder: 0,
}

describe('property.addons.repo', { tags: ['db'], timeout: 30_000 }, () => {
	let repo: ReturnType<typeof createAddonsRepo>
	const created: Array<{ tenantId: string; propertyId: string; addonId: string }> = []

	beforeAll(async () => {
		await setupTestDb()
		repo = createAddonsRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const c of created) {
			await sql`DELETE FROM propertyAddon WHERE tenantId = ${c.tenantId} AND propertyId = ${c.propertyId} AND addonId = ${c.addonId}`
		}
		await teardownTestDb()
	})

	test('[I1] create: byte-exact roundtrip — every field', async () => {
		const id = `addon_i1_${RUN_ID}`
		const out = await repo.create(TENANT_A, PROPERTY_A1, id, breakfastInput, ACTOR)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, addonId: id })
		expect(out.code).toBe('BREAKFAST')
		expect(out.category).toBe('FOOD_AND_BEVERAGES')
		expect(out.nameRu).toBe('Завтрак')
		expect(out.nameEn).toBeNull()
		expect(out.pricingUnit).toBe('PER_NIGHT_PER_PERSON')
		expect(out.priceMicros).toBe(800_000_000n)
		expect(out.currency).toBe('RUB')
		expect(out.vatBps).toBe(0)
		expect(out.isActive).toBe(true)
		expect(out.isMandatory).toBe(false)
		expect(out.inventoryMode).toBe('NONE')
		expect(out.dailyCapacity).toBeNull()
		expect(out.seasonalTags).toEqual([])
		expect(out.sortOrder).toBe(0)
		expect(out.createdAt).toMatch(ISO)
		expect(out.createdAt).toBe(out.updatedAt)

		const fetched = await repo.getById(TENANT_A, PROPERTY_A1, id)
		expect(fetched).toEqual(out)
	})

	test('[I2] create with seasonalTags array roundtrips correctly', async () => {
		const id = `addon_i2_${RUN_ID}`
		await repo.create(
			TENANT_A,
			PROPERTY_A1,
			id,
			{ ...breakfastInput, code: 'SKI_PASS', seasonalTags: ['ski-season', 'new-year-peak'] },
			ACTOR,
		)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, addonId: id })
		const fetched = await repo.getById(TENANT_A, PROPERTY_A1, id)
		expect(fetched?.seasonalTags).toEqual(['ski-season', 'new-year-peak'])
	})

	test('[I3] create DAILY_COUNTER mode persists dailyCapacity', async () => {
		const id = `addon_i3_${RUN_ID}`
		await repo.create(
			TENANT_A,
			PROPERTY_A1,
			id,
			{
				...breakfastInput,
				code: 'BREAKFAST_LIMITED',
				inventoryMode: 'DAILY_COUNTER',
				dailyCapacity: 25,
			},
			ACTOR,
		)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, addonId: id })
		const fetched = await repo.getById(TENANT_A, PROPERTY_A1, id)
		expect(fetched?.inventoryMode).toBe('DAILY_COUNTER')
		expect(fetched?.dailyCapacity).toBe(25)
	})

	test('[I4] priceMicros at MAX_SAFE_INTEGER + 1 roundtrips exactly (bigint precision)', async () => {
		const id = `addon_i4_${RUN_ID}`
		const big = BigInt(Number.MAX_SAFE_INTEGER) + 1n
		await repo.create(
			TENANT_A,
			PROPERTY_A1,
			id,
			{ ...breakfastInput, code: 'BIG_PRICE', priceMicros: big },
			ACTOR,
		)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, addonId: id })
		const fetched = await repo.getById(TENANT_A, PROPERTY_A1, id)
		expect(fetched?.priceMicros).toBe(big)
		expect(typeof fetched?.priceMicros).toBe('bigint')
	})

	test('[L1] listByProperty: ORDER BY sortOrder, code', async () => {
		const id1 = `addon_l1_z_${RUN_ID}`
		const id2 = `addon_l1_a_${RUN_ID}`
		const id3 = `addon_l1_m_${RUN_ID}`
		await repo.create(
			TENANT_B,
			PROPERTY_B1,
			id1,
			{ ...breakfastInput, code: 'ZZZ', sortOrder: 5 },
			ACTOR,
		)
		await repo.create(
			TENANT_B,
			PROPERTY_B1,
			id2,
			{ ...breakfastInput, code: 'AAA', sortOrder: 5 },
			ACTOR,
		)
		await repo.create(
			TENANT_B,
			PROPERTY_B1,
			id3,
			{ ...breakfastInput, code: 'MMM', sortOrder: 0 },
			ACTOR,
		)
		created.push({ tenantId: TENANT_B, propertyId: PROPERTY_B1, addonId: id1 })
		created.push({ tenantId: TENANT_B, propertyId: PROPERTY_B1, addonId: id2 })
		created.push({ tenantId: TENANT_B, propertyId: PROPERTY_B1, addonId: id3 })

		const list = await repo.listByProperty(TENANT_B, PROPERTY_B1)
		const codes = list.map((a) => a.code)
		expect(codes).toEqual(['MMM', 'AAA', 'ZZZ']) // (sort=0, code=MMM), (sort=5, code=AAA), (sort=5, code=ZZZ)
	})

	test('[L2] listByProperty filter: onlyActive=true excludes inactive', async () => {
		const idActive = `addon_l2_active_${RUN_ID}`
		const idInactive = `addon_l2_inactive_${RUN_ID}`
		await repo.create(
			TENANT_A,
			PROPERTY_A2,
			idActive,
			{ ...breakfastInput, code: 'ACTIVE_X', isActive: true },
			ACTOR,
		)
		await repo.create(
			TENANT_A,
			PROPERTY_A2,
			idInactive,
			{ ...breakfastInput, code: 'INACTIVE_X', isActive: false },
			ACTOR,
		)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A2, addonId: idActive })
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A2, addonId: idInactive })

		const all = await repo.listByProperty(TENANT_A, PROPERTY_A2)
		expect(all).toHaveLength(2)
		const activeOnly = await repo.listByProperty(TENANT_A, PROPERTY_A2, { onlyActive: true })
		expect(activeOnly).toHaveLength(1)
		expect(activeOnly[0]?.code).toBe('ACTIVE_X')
	})

	test('[L3] listByProperty filter: category narrows results', async () => {
		const id = `addon_l3_transfer_${RUN_ID}`
		await repo.create(
			TENANT_A,
			PROPERTY_A2,
			id,
			{ ...breakfastInput, code: 'AIRPORT_TRANSFER', category: 'TRANSFER' },
			ACTOR,
		)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A2, addonId: id })

		const transfer = await repo.listByProperty(TENANT_A, PROPERTY_A2, { category: 'TRANSFER' })
		expect(transfer.find((a) => a.code === 'AIRPORT_TRANSFER')).toBeDefined()
		expect(transfer.find((a) => a.code === 'ACTIVE_X')).toBeUndefined() // filtered out
	})

	test('[E1] existsByCode true for known + false for unknown', async () => {
		const id = `addon_e1_${RUN_ID}`
		await repo.create(
			TENANT_A,
			PROPERTY_A2,
			id,
			{ ...breakfastInput, code: 'UNIQUE_CODE_E1' },
			ACTOR,
		)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A2, addonId: id })
		expect(await repo.existsByCode(TENANT_A, PROPERTY_A2, 'UNIQUE_CODE_E1')).toBe(true)
		expect(await repo.existsByCode(TENANT_A, PROPERTY_A2, 'NEVER_SEEN')).toBe(false)
	})

	test('[E2] existsByCode is tenant-scoped (cross-tenant returns false)', async () => {
		expect(await repo.existsByCode(TENANT_B, PROPERTY_A2, 'UNIQUE_CODE_E1')).toBe(false)
	})

	test('[P1] patch: three-state semantics on nameEn (undefined / null / string)', async () => {
		const id = `addon_p1_${RUN_ID}`
		await repo.create(
			TENANT_A,
			PROPERTY_A2,
			id,
			{ ...breakfastInput, code: 'PATCH_TEST', nameEn: 'Original' },
			ACTOR,
		)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A2, addonId: id })

		// undefined → keep
		const r1 = await repo.patch(TENANT_A, PROPERTY_A2, id, { nameRu: 'New RU' }, ACTOR)
		expect(r1?.nameEn).toBe('Original')

		// null → clear
		const r2 = await repo.patch(TENANT_A, PROPERTY_A2, id, { nameEn: null }, ACTOR)
		expect(r2?.nameEn).toBeNull()

		// string → set
		const r3 = await repo.patch(TENANT_A, PROPERTY_A2, id, { nameEn: 'Reset' }, ACTOR)
		expect(r3?.nameEn).toBe('Reset')
	})

	test('[P2] patch preserves createdAt; updates updatedAt monotonic', async () => {
		const id = `addon_p2_${RUN_ID}`
		const c = await repo.create(
			TENANT_A,
			PROPERTY_A2,
			id,
			{ ...breakfastInput, code: 'P2_CODE' },
			ACTOR,
		)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A2, addonId: id })
		await new Promise((r) => setTimeout(r, 5))
		const out = await repo.patch(TENANT_A, PROPERTY_A2, id, { priceMicros: 1_500_000_000n }, ACTOR)
		expect(out?.createdAt).toBe(c.createdAt)
		expect(new Date(out?.updatedAt as string).getTime()).toBeGreaterThan(
			new Date(c.updatedAt).getTime(),
		)
		expect(out?.priceMicros).toBe(1_500_000_000n)
	})

	test('[P3] patch dailyCapacity null roundtrips (clear)', async () => {
		const id = `addon_p3_${RUN_ID}`
		await repo.create(
			TENANT_A,
			PROPERTY_A2,
			id,
			{
				...breakfastInput,
				code: 'P3_CODE',
				inventoryMode: 'DAILY_COUNTER',
				dailyCapacity: 50,
			},
			ACTOR,
		)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A2, addonId: id })

		const out = await repo.patch(
			TENANT_A,
			PROPERTY_A2,
			id,
			{ dailyCapacity: null, inventoryMode: 'NONE' },
			ACTOR,
		)
		expect(out?.dailyCapacity).toBeNull()
		expect(out?.inventoryMode).toBe('NONE')
	})

	test('[P4] patch returns null for unknown addonId', async () => {
		expect(await repo.patch(TENANT_A, PROPERTY_A2, 'addon_fake', { nameRu: 'X' }, ACTOR)).toBeNull()
	})

	test('[D1] delete: returns true and removes row', async () => {
		const id = `addon_d1_${RUN_ID}`
		await repo.create(TENANT_A, PROPERTY_A2, id, { ...breakfastInput, code: 'D1_CODE' }, ACTOR)
		expect(await repo.getById(TENANT_A, PROPERTY_A2, id)).not.toBeNull()
		expect(await repo.delete(TENANT_A, PROPERTY_A2, id)).toBe(true)
		expect(await repo.getById(TENANT_A, PROPERTY_A2, id)).toBeNull()
	})

	test('[D2] delete: returns false on unknown addonId (idempotent)', async () => {
		expect(await repo.delete(TENANT_A, PROPERTY_A2, 'addon_d2_fake')).toBe(false)
	})

	test('[CT1] cross-tenant: TENANT_A row invisible to TENANT_B', async () => {
		const id = `addon_ct1_${RUN_ID}`
		await repo.create(TENANT_A, PROPERTY_A2, id, { ...breakfastInput, code: 'CT1_CODE' }, ACTOR)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A2, addonId: id })
		expect(await repo.getById(TENANT_A, PROPERTY_A2, id)).not.toBeNull()
		expect(await repo.getById(TENANT_B, PROPERTY_A2, id)).toBeNull()
	})

	test('[CT2] cross-tenant: existsByCode does not leak across tenants', async () => {
		const id = `addon_ct2_${RUN_ID}`
		await repo.create(TENANT_A, PROPERTY_A2, id, { ...breakfastInput, code: 'SHARED_CODE' }, ACTOR)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A2, addonId: id })
		// Same code at TENANT_B is allowed — uniqueness is tenant-scoped.
		expect(await repo.existsByCode(TENANT_A, PROPERTY_A2, 'SHARED_CODE')).toBe(true)
		expect(await repo.existsByCode(TENANT_B, PROPERTY_A2, 'SHARED_CODE')).toBe(false)
	})

	test('[CP1] cross-property: same tenant, same code can exist on two properties', async () => {
		const idA1 = `addon_cp1_a1_${RUN_ID}`
		const idA2 = `addon_cp1_a2_${RUN_ID}`
		await repo.create(TENANT_A, PROPERTY_A1, idA1, { ...breakfastInput, code: 'CP1_CODE' }, ACTOR)
		await repo.create(TENANT_A, PROPERTY_A2, idA2, { ...breakfastInput, code: 'CP1_CODE' }, ACTOR)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, addonId: idA1 })
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A2, addonId: idA2 })

		expect(await repo.existsByCode(TENANT_A, PROPERTY_A1, 'CP1_CODE')).toBe(true)
		expect(await repo.existsByCode(TENANT_A, PROPERTY_A2, 'CP1_CODE')).toBe(true)
	})

	test('[E3] reading row with corrupt seasonalTagsJson raises descriptive error', async () => {
		const sql = getTestSql()
		const id = `addon_corrupt_${RUN_ID}`
		const now = new Date()
		await sql`
			UPSERT INTO propertyAddon (
				\`tenantId\`, \`propertyId\`, \`addonId\`,
				\`code\`, \`category\`,
				\`nameRu\`, \`pricingUnit\`, \`priceMicros\`, \`currency\`, \`vatBps\`,
				\`isActive\`, \`isMandatory\`,
				\`inventoryMode\`,
				\`seasonalTagsJson\`, \`sortOrder\`,
				\`createdAt\`, \`createdBy\`, \`updatedAt\`, \`updatedBy\`
			) VALUES (
				${TENANT_A}, ${PROPERTY_A2}, ${id},
				${'CORRUPT'}, ${'OTHER'},
				${'X'}, ${'PER_STAY'}, ${1_000_000n}, ${'RUB'}, ${0},
				${true}, ${false},
				${'NONE'},
				${'this-is-not-json'}, ${0},
				${now}, ${'test'}, ${now}, ${'test'}
			)
		`
		await expect(repo.getById(TENANT_A, PROPERTY_A2, id)).rejects.toThrowError(
			/Corrupt seasonalTagsJson/,
		)
		await sql`DELETE FROM propertyAddon WHERE tenantId = ${TENANT_A} AND propertyId = ${PROPERTY_A2} AND addonId = ${id}`
	})

	test('[V1] every VAT rate enum value roundtrips (full enum coverage)', async () => {
		const rates = [0, 1000, 2000, 2200] as const
		for (const rate of rates) {
			const id = `addon_vat_${rate}_${RUN_ID}`
			await repo.create(
				TENANT_A,
				PROPERTY_A1,
				id,
				{ ...breakfastInput, code: `VAT_${rate}`, vatBps: rate },
				ACTOR,
			)
			created.push({ tenantId: TENANT_A, propertyId: PROPERTY_A1, addonId: id })
			const fetched = await repo.getById(TENANT_A, PROPERTY_A1, id)
			expect(fetched?.vatBps).toBe(rate)
		}
	})
})
