/**
 * Widget repo — strict tests per `feedback_strict_tests.md`.
 *
 * Test matrix:
 *   ─── isPublic filter ──────────────────────────────────────────
 *     [P1] property с isPublic=true + isActive=true → exposed
 *     [P2] property с isPublic=NULL → hidden (canon: NULL = private)
 *     [P3] property с isPublic=false → hidden
 *     [P4] property с isPublic=true + isActive=false → hidden
 *
 *   ─── Cross-tenant isolation ────────────────────────────────────
 *     [T1] listPublicProperties from wrong tenant returns []
 *     [T2] getPublicProperty from wrong tenant returns null
 *     [T3] listRoomTypes from wrong tenant returns [] (regression)
 *
 *   ─── RoomType list ─────────────────────────────────────────────
 *     [RT1] returns roomTypes только для requested propertyId
 *     [RT2] empty array если property has no roomTypes
 *
 *   ─── Public addons (M9.widget.3) — server-side compliance filters ─
 *     [PA1] isActive=true + isMandatory=false + inventoryMode=NONE → exposed
 *     [PA2] isActive=false → hidden
 *     [PA3] isMandatory=true → hidden (folded into rate quote, не extras screen)
 *     [PA4] inventoryMode='TIME_SLOT' → hidden (deferred per shared canon)
 *     [PA5] cross-tenant: listPublicAddons from wrong tenant returns []
 *     [PA6] sortOrder respects ordering (lower → first)
 *     [PA7] property without addons → empty array
 *     [PA8] seasonalTagsJson parsed correctly to typed array
 *     [PA9] corrupt seasonalTagsJson raises descriptive error (defense-in-depth)
 *     [PA10] DAILY_COUNTER mode exposed (опт-side complement to PA4)
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { NULL_INT32 } from '../../db/ydb-helpers.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createWidgetRepo } from './widget.repo.ts'

describe('widget.repo', { tags: ['db'], timeout: 60_000 }, () => {
	beforeAll(async () => {
		await setupTestDb()
	})

	afterAll(async () => {
		await teardownTestDb()
	})

	async function seedProperty(opts: {
		tenantId: string
		propertyId: string
		isPublic: boolean | null
		isActive?: boolean
		name?: string
	}) {
		const sql = getTestSql()
		const now = new Date()
		const isActive = opts.isActive ?? true
		const isPublic = opts.isPublic
		if (isPublic === null) {
			await sql`
				UPSERT INTO property (
					\`tenantId\`, \`id\`, \`name\`, \`address\`, \`city\`, \`timezone\`,
					\`isActive\`, \`createdAt\`, \`updatedAt\`
				) VALUES (
					${opts.tenantId}, ${opts.propertyId},
					${opts.name ?? 'Test Property'},
					${'addr'}, ${'Sochi'}, ${'Europe/Moscow'},
					${isActive}, ${now}, ${now}
				)
			`
		} else {
			await sql`
				UPSERT INTO property (
					\`tenantId\`, \`id\`, \`name\`, \`address\`, \`city\`, \`timezone\`,
					\`isActive\`, \`isPublic\`, \`createdAt\`, \`updatedAt\`
				) VALUES (
					${opts.tenantId}, ${opts.propertyId},
					${opts.name ?? 'Test Property'},
					${'addr'}, ${'Sochi'}, ${'Europe/Moscow'},
					${isActive}, ${isPublic}, ${now}, ${now}
				)
			`
		}
	}

	async function seedRoomType(opts: {
		tenantId: string
		propertyId: string
		id: string
		name: string
	}) {
		const sql = getTestSql()
		const now = new Date()
		await sql`
			UPSERT INTO roomType (
				\`tenantId\`, \`id\`, \`propertyId\`, \`name\`, \`description\`,
				\`maxOccupancy\`, \`baseBeds\`, \`extraBeds\`, \`areaSqm\`,
				\`inventoryCount\`, \`isActive\`, \`createdAt\`, \`updatedAt\`
			) VALUES (
				${opts.tenantId}, ${opts.id}, ${opts.propertyId},
				${opts.name}, ${'desc'},
				${2}, ${1}, ${0}, ${20},
				${5}, ${true}, ${now}, ${now}
			)
		`
	}

	test('[P1] isPublic=true + isActive=true → exposed', async () => {
		const repo = createWidgetRepo(getTestSql())
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedProperty({ tenantId, propertyId, isPublic: true })
		const list = await repo.listPublicProperties(tenantId)
		expect(list).toHaveLength(1)
		expect(list[0]?.id).toBe(propertyId)
		const detail = await repo.getPublicProperty(tenantId, propertyId)
		expect(detail).not.toBeNull()
		expect(detail?.id).toBe(propertyId)
	})

	test('[P2] isPublic=NULL → hidden (NULL = private canon)', async () => {
		const repo = createWidgetRepo(getTestSql())
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedProperty({ tenantId, propertyId, isPublic: null })
		const list = await repo.listPublicProperties(tenantId)
		expect(list).toHaveLength(0)
		const detail = await repo.getPublicProperty(tenantId, propertyId)
		expect(detail).toBeNull()
	})

	test('[P3] isPublic=false → hidden', async () => {
		const repo = createWidgetRepo(getTestSql())
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedProperty({ tenantId, propertyId, isPublic: false })
		const list = await repo.listPublicProperties(tenantId)
		expect(list).toHaveLength(0)
		const detail = await repo.getPublicProperty(tenantId, propertyId)
		expect(detail).toBeNull()
	})

	test('[P4] isPublic=true + isActive=false → hidden', async () => {
		const repo = createWidgetRepo(getTestSql())
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedProperty({ tenantId, propertyId, isPublic: true, isActive: false })
		const list = await repo.listPublicProperties(tenantId)
		expect(list).toHaveLength(0)
		const detail = await repo.getPublicProperty(tenantId, propertyId)
		expect(detail).toBeNull()
	})

	test('[T1] cross-tenant: list from wrong tenant returns []', async () => {
		const repo = createWidgetRepo(getTestSql())
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const propertyId = newId('property')
		await seedProperty({ tenantId: tenantA, propertyId, isPublic: true, name: 'A-only' })
		const fromB = await repo.listPublicProperties(tenantB)
		expect(fromB).toHaveLength(0)
		// Sanity: tenantA still sees own property
		const fromA = await repo.listPublicProperties(tenantA)
		expect(fromA.find((p) => p.id === propertyId)).toBeDefined()
	})

	test('[T2] cross-tenant: getPublicProperty from wrong tenant returns null', async () => {
		const repo = createWidgetRepo(getTestSql())
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const propertyId = newId('property')
		await seedProperty({ tenantId: tenantA, propertyId, isPublic: true })
		const fromB = await repo.getPublicProperty(tenantB, propertyId)
		expect(fromB).toBeNull()
		// Sanity
		const fromA = await repo.getPublicProperty(tenantA, propertyId)
		expect(fromA).not.toBeNull()
	})

	test('[T3] cross-tenant: listRoomTypes from wrong tenant returns []', async () => {
		const repo = createWidgetRepo(getTestSql())
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const propertyId = newId('property')
		const roomTypeId = newId('roomType')
		await seedProperty({ tenantId: tenantA, propertyId, isPublic: true })
		await seedRoomType({ tenantId: tenantA, propertyId, id: roomTypeId, name: 'Suite' })
		const fromB = await repo.listRoomTypesForProperty(tenantB, propertyId)
		expect(fromB).toHaveLength(0)
	})

	test('[RT1] roomTypes only for requested propertyId', async () => {
		const repo = createWidgetRepo(getTestSql())
		const tenantId = newId('organization')
		const property1 = newId('property')
		const property2 = newId('property')
		const rt1 = newId('roomType')
		const rt2 = newId('roomType')
		await seedProperty({ tenantId, propertyId: property1, isPublic: true })
		await seedProperty({ tenantId, propertyId: property2, isPublic: true })
		await seedRoomType({ tenantId, propertyId: property1, id: rt1, name: 'Type1' })
		await seedRoomType({ tenantId, propertyId: property2, id: rt2, name: 'Type2' })
		const list1 = await repo.listRoomTypesForProperty(tenantId, property1)
		expect(list1).toHaveLength(1)
		expect(list1[0]?.id).toBe(rt1)
		expect(list1[0]?.name).toBe('Type1')
	})

	test('[RT2] property without roomTypes → empty array', async () => {
		const repo = createWidgetRepo(getTestSql())
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedProperty({ tenantId, propertyId, isPublic: true })
		const list = await repo.listRoomTypesForProperty(tenantId, propertyId)
		expect(list).toHaveLength(0)
	})

	async function seedAddon(opts: {
		tenantId: string
		propertyId: string
		addonId: string
		code: string
		isActive?: boolean
		isMandatory?: boolean
		inventoryMode?: 'NONE' | 'DAILY_COUNTER' | 'TIME_SLOT'
		dailyCapacity?: number | null
		sortOrder?: number
		nameRu?: string
		category?: string
		pricingUnit?: string
		priceMicros?: bigint
		vatBps?: number
		seasonalTagsJson?: string
	}) {
		const sql = getTestSql()
		const now = new Date()
		const dailyCapacityParam =
			opts.dailyCapacity === undefined || opts.dailyCapacity === null
				? NULL_INT32
				: opts.dailyCapacity
		await sql`
			UPSERT INTO propertyAddon (
				\`tenantId\`, \`propertyId\`, \`addonId\`,
				\`code\`, \`category\`,
				\`nameRu\`, \`pricingUnit\`, \`priceMicros\`, \`currency\`, \`vatBps\`,
				\`isActive\`, \`isMandatory\`,
				\`inventoryMode\`, \`dailyCapacity\`,
				\`seasonalTagsJson\`, \`sortOrder\`,
				\`createdAt\`, \`createdBy\`, \`updatedAt\`, \`updatedBy\`
			) VALUES (
				${opts.tenantId}, ${opts.propertyId}, ${opts.addonId},
				${opts.code}, ${opts.category ?? 'OTHER'},
				${opts.nameRu ?? 'Завтрак'},
				${opts.pricingUnit ?? 'PER_NIGHT'}, ${opts.priceMicros ?? 1_500_000_000n},
				${'RUB'}, ${opts.vatBps ?? 2200},
				${opts.isActive ?? true}, ${opts.isMandatory ?? false},
				${opts.inventoryMode ?? 'NONE'},
				${dailyCapacityParam},
				${opts.seasonalTagsJson ?? '[]'}, ${opts.sortOrder ?? 0},
				${now}, ${'test'}, ${now}, ${'test'}
			)
		`
	}

	test('[PA1] isActive=true + isMandatory=false + inventoryMode=NONE → exposed', async () => {
		const repo = createWidgetRepo(getTestSql())
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const addonId = newId('addon')
		await seedProperty({ tenantId, propertyId, isPublic: true })
		await seedAddon({
			tenantId,
			propertyId,
			addonId,
			code: 'PA1_BREAKFAST',
			nameRu: 'Завтрак-буфет',
			category: 'FOOD_AND_BEVERAGES',
			pricingUnit: 'PER_NIGHT_PER_PERSON',
			priceMicros: 1_500_000_000n,
			vatBps: 2200,
		})
		const list = await repo.listPublicAddons(tenantId, propertyId)
		expect(list).toHaveLength(1)
		expect(list[0]?.addonId).toBe(addonId)
		expect(list[0]?.code).toBe('PA1_BREAKFAST')
		expect(list[0]?.nameRu).toBe('Завтрак-буфет')
		expect(list[0]?.category).toBe('FOOD_AND_BEVERAGES')
		expect(list[0]?.pricingUnit).toBe('PER_NIGHT_PER_PERSON')
		expect(list[0]?.priceMicros).toBe(1_500_000_000n)
		expect(list[0]?.vatBps).toBe(2200)
		expect(list[0]?.inventoryMode).toBe('NONE')
		expect(list[0]?.dailyCapacity).toBeNull()
	})

	test('[PA2] isActive=false → hidden', async () => {
		const repo = createWidgetRepo(getTestSql())
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const addonId = newId('addon')
		await seedProperty({ tenantId, propertyId, isPublic: true })
		await seedAddon({
			tenantId,
			propertyId,
			addonId,
			code: 'PA2_INACTIVE',
			isActive: false,
		})
		const list = await repo.listPublicAddons(tenantId, propertyId)
		expect(list).toHaveLength(0)
	})

	test('[PA3] isMandatory=true → hidden (folded into rate quote)', async () => {
		const repo = createWidgetRepo(getTestSql())
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const addonId = newId('addon')
		await seedProperty({ tenantId, propertyId, isPublic: true })
		await seedAddon({
			tenantId,
			propertyId,
			addonId,
			code: 'PA3_MANDATORY_CITY_TAX',
			isMandatory: true,
		})
		const list = await repo.listPublicAddons(tenantId, propertyId)
		expect(list).toHaveLength(0)
	})

	test("[PA4] inventoryMode='TIME_SLOT' → hidden (deferred)", async () => {
		const repo = createWidgetRepo(getTestSql())
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const addonId = newId('addon')
		await seedProperty({ tenantId, propertyId, isPublic: true })
		await seedAddon({
			tenantId,
			propertyId,
			addonId,
			code: 'PA4_SPA_TIMESLOT',
			inventoryMode: 'TIME_SLOT',
			dailyCapacity: 4,
		})
		const list = await repo.listPublicAddons(tenantId, propertyId)
		expect(list).toHaveLength(0)
	})

	test('[PA5] cross-tenant: listPublicAddons from wrong tenant returns []', async () => {
		const repo = createWidgetRepo(getTestSql())
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const propertyId = newId('property')
		const addonId = newId('addon')
		await seedProperty({ tenantId: tenantA, propertyId, isPublic: true })
		await seedAddon({
			tenantId: tenantA,
			propertyId,
			addonId,
			code: 'PA5_CROSS_TENANT',
		})
		// Tenant B asks: should NOT see tenant A's addon
		const fromB = await repo.listPublicAddons(tenantB, propertyId)
		expect(fromB).toHaveLength(0)
		// Sanity: tenantA still sees own addon
		const fromA = await repo.listPublicAddons(tenantA, propertyId)
		expect(fromA).toHaveLength(1)
		expect(fromA[0]?.addonId).toBe(addonId)
	})

	test('[PA6] sortOrder respects ordering (lower → first)', async () => {
		const repo = createWidgetRepo(getTestSql())
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const addonHi = newId('addon')
		const addonLo = newId('addon')
		await seedProperty({ tenantId, propertyId, isPublic: true })
		await seedAddon({
			tenantId,
			propertyId,
			addonId: addonHi,
			code: 'PA6_HI',
			sortOrder: 100,
		})
		await seedAddon({
			tenantId,
			propertyId,
			addonId: addonLo,
			code: 'PA6_LO',
			sortOrder: 1,
		})
		const list = await repo.listPublicAddons(tenantId, propertyId)
		expect(list).toHaveLength(2)
		expect(list[0]?.addonId).toBe(addonLo)
		expect(list[1]?.addonId).toBe(addonHi)
	})

	test('[PA7] property without addons → empty array', async () => {
		const repo = createWidgetRepo(getTestSql())
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedProperty({ tenantId, propertyId, isPublic: true })
		const list = await repo.listPublicAddons(tenantId, propertyId)
		expect(list).toHaveLength(0)
	})

	test('[PA8] seasonalTagsJson parsed correctly to typed array', async () => {
		const repo = createWidgetRepo(getTestSql())
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const addonId = newId('addon')
		await seedProperty({ tenantId, propertyId, isPublic: true })
		await seedAddon({
			tenantId,
			propertyId,
			addonId,
			code: 'PA8_SEASONAL',
			seasonalTagsJson: '["ski-season","new-year-peak"]',
		})
		const list = await repo.listPublicAddons(tenantId, propertyId)
		expect(list).toHaveLength(1)
		expect(list[0]?.seasonalTags).toEqual(['ski-season', 'new-year-peak'])
	})

	test('[PA9] corrupt seasonalTagsJson raises descriptive error', async () => {
		const repo = createWidgetRepo(getTestSql())
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const addonId = newId('addon')
		await seedProperty({ tenantId, propertyId, isPublic: true })
		await seedAddon({
			tenantId,
			propertyId,
			addonId,
			code: 'PA9_CORRUPT',
			seasonalTagsJson: 'this-is-not-json',
		})
		await expect(repo.listPublicAddons(tenantId, propertyId)).rejects.toThrowError(
			/Corrupt seasonalTagsJson/,
		)
	})

	test('[PA10] DAILY_COUNTER inventoryMode exposed (counter-test for PA4)', async () => {
		const repo = createWidgetRepo(getTestSql())
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const addonId = newId('addon')
		await seedProperty({ tenantId, propertyId, isPublic: true })
		await seedAddon({
			tenantId,
			propertyId,
			addonId,
			code: 'PA10_PARKING_LIMITED',
			category: 'PARKING',
			inventoryMode: 'DAILY_COUNTER',
			dailyCapacity: 10,
		})
		const list = await repo.listPublicAddons(tenantId, propertyId)
		expect(list).toHaveLength(1)
		expect(list[0]?.inventoryMode).toBe('DAILY_COUNTER')
		expect(list[0]?.dailyCapacity).toBe(10)
	})
})
