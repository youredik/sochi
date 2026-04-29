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
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
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
})
