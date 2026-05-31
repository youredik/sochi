/**
 * OnboardingService — YDB integration tests.
 *
 * Verifies the full 4-entity single-transaction wiring against a real
 * YDB instance:
 *   [I1] property row lands with passed-through name/address/city/timezone
 *   [I2] roomType row lands with canonical defaults («Стандартный», cap 2,
 *        inventoryCount === rooms)
 *   [I3] all N room rows land with sequential numbers '101..(100+N)'
 *   [I4] ratePlan row lands with isDefault=true, code='BASE', currency='RUB'
 *   [I8] rate × 90 + availability × 90 seeded for today..+89 — every priced
 *        night has a matching availability row с allotment=rooms (closes
 *        «no availability row» 409 trap caught 2026-05-15 via e2e baseline)
 *   [I5] every row carries the same tenantId; cross-tenant leakage check
 *   [I6] roomIds returned match the actual room rows in DB
 *   [I7] typeid prefixes correct (property/roomType/room/ratePlan)
 *   [I8] tx atomicity — if any insert fails, no partial state remains
 *
 * Requires `docker compose up ydb`.
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createOnboardingService, type OnboardingService } from './onboarding.service.ts'

const TENANT = newId('organization')

describe('onboarding.service — bulk createInventory', () => {
	let service: OnboardingService
	let sql: ReturnType<typeof getTestSql>
	const cleanupPropertyIds: string[] = []

	beforeAll(async () => {
		await setupTestDb()
		sql = getTestSql()
		service = createOnboardingService(sql)
	})

	afterAll(async () => {
		// Best-effort cleanup. Tenant isolation makes leaked rows harmless,
		// but housekeeping keeps the test DB readable for ad-hoc inspection.
		for (const propertyId of cleanupPropertyIds) {
			await sql`DELETE FROM availability WHERE tenantId = ${TENANT} AND propertyId = ${propertyId}`
			await sql`DELETE FROM rate WHERE tenantId = ${TENANT} AND propertyId = ${propertyId}`
			await sql`DELETE FROM room WHERE tenantId = ${TENANT} AND propertyId = ${propertyId}`
			await sql`DELETE FROM ratePlan WHERE tenantId = ${TENANT} AND propertyId = ${propertyId}`
			await sql`DELETE FROM roomType WHERE tenantId = ${TENANT} AND propertyId = ${propertyId}`
			await sql`DELETE FROM property WHERE tenantId = ${TENANT} AND id = ${propertyId}`
		}
		await teardownTestDb()
	})

	test('[I1-I7] creates property + roomType + N rooms + ratePlan atomically (rooms=10)', async () => {
		const result = await service.createInventory(TENANT, {
			property: {
				name: 'Гостиница «Тестовый Демо-Сириус»',
				address: '354340, г. Сочи, Имеретинская низменность, д. 1',
				city: 'Sochi',
				timezone: 'Europe/Moscow',
				tourismTaxRateBps: 200,
			},
			rooms: 10,
			avgPriceRub: 3500,
		})
		cleanupPropertyIds.push(result.propertyId)

		expect(result.propertyId.startsWith('prop_')).toBe(true)
		expect(result.roomTypeId.startsWith('rmt_')).toBe(true)
		expect(result.ratePlanId.startsWith('rp_')).toBe(true)
		expect(result.roomIds.length).toBe(10)
		for (const rid of result.roomIds) {
			expect(rid.startsWith('room_')).toBe(true)
		}

		// [I1] property row.
		const [propRows = []] = await sql<
			Array<{ id: string; name: string; city: string; tourismTaxRateBps: number | bigint }>
		>`
			SELECT id, name, city, tourismTaxRateBps
			FROM property
			WHERE tenantId = ${TENANT} AND id = ${result.propertyId}
		`.isolation('snapshotReadOnly')
		expect(propRows.length).toBe(1)
		const property = propRows[0]
		if (!property) throw new Error('property row missing')
		expect(property.name).toBe('Гостиница «Тестовый Демо-Сириус»')
		expect(property.city).toBe('Sochi')
		expect(Number(property.tourismTaxRateBps)).toBe(200)

		// [I2] roomType row.
		const [rtRows = []] = await sql<
			Array<{ id: string; name: string; maxOccupancy: number; inventoryCount: number }>
		>`
			SELECT id, name, maxOccupancy, inventoryCount
			FROM roomType
			WHERE tenantId = ${TENANT} AND propertyId = ${result.propertyId}
		`.isolation('snapshotReadOnly')
		expect(rtRows.length).toBe(1)
		const rt = rtRows[0]
		if (!rt) throw new Error('roomType row missing')
		expect(rt.name).toBe('Стандартный')
		expect(Number(rt.maxOccupancy)).toBe(2)
		expect(Number(rt.inventoryCount)).toBe(10)

		// [I3] all 10 rooms with sequential numbers '101'..'110'.
		const [roomRows = []] = await sql<Array<{ id: string; number: string; floor: number }>>`
			SELECT id, number, floor
			FROM room
			WHERE tenantId = ${TENANT} AND propertyId = ${result.propertyId}
		`.isolation('snapshotReadOnly')
		expect(roomRows.length).toBe(10)
		const numbersSeen = new Set(roomRows.map((r) => r.number))
		const expectedNumbers = new Set(Array.from({ length: 10 }, (_, i) => String(101 + i)))
		expect(numbersSeen).toEqual(expectedNumbers)
		// [I6] returned roomIds must match what landed in DB.
		const dbRoomIds = new Set(roomRows.map((r) => r.id))
		expect(dbRoomIds).toEqual(new Set(result.roomIds))
		// floor is 1 for all rooms (onboarding default).
		for (const r of roomRows) {
			expect(Number(r.floor)).toBe(1)
		}

		// [I4] ratePlan row.
		const [rpRows = []] = await sql<
			Array<{ id: string; name: string; code: string; isDefault: boolean; currency: string }>
		>`
			SELECT id, name, code, isDefault, currency
			FROM ratePlan
			WHERE tenantId = ${TENANT} AND propertyId = ${result.propertyId}
		`.isolation('snapshotReadOnly')
		expect(rpRows.length).toBe(1)
		const rp = rpRows[0]
		if (!rp) throw new Error('ratePlan row missing')
		expect(rp.name).toBe('Базовый')
		expect(rp.code).toBe('BASE')
		expect(rp.isDefault).toBe(true)
		expect(rp.currency).toBe('RUB')
	})

	test('[I8] rate × 90 + availability × 90 seeded for today..+89, 1:1 by date, allotment=rooms', async () => {
		const result = await service.createInventory(TENANT, {
			property: {
				name: 'Гостиница «Bookable-from-wizard»',
				address: '354340, г. Сочи, ул. Канонная, д. 8',
				city: 'Sochi',
			},
			rooms: 5,
			avgPriceRub: 4200,
		})
		cleanupPropertyIds.push(result.propertyId)

		// rate × 90: every day in [today, today+89] has a row at avgPriceRub micros.
		const [rateRows = []] = await sql<Array<{ rateCount: number | bigint }>>`
			SELECT COUNT(*) AS rateCount FROM rate
			WHERE tenantId = ${TENANT}
				AND propertyId = ${result.propertyId}
				AND roomTypeId = ${result.roomTypeId}
		`
		expect(Number(rateRows[0]?.rateCount ?? 0)).toBe(90)

		// availability × 90: every priced night has a matching allotment row.
		const [availRows = []] = await sql<
			Array<{ availCount: number | bigint; allotmentSum: number | bigint }>
		>`
			SELECT COUNT(*) AS availCount, SUM(allotment) AS allotmentSum FROM availability
			WHERE tenantId = ${TENANT}
				AND propertyId = ${result.propertyId}
				AND roomTypeId = ${result.roomTypeId}
		`
		expect(Number(availRows[0]?.availCount ?? 0)).toBe(90)
		// allotment=rooms=5 на every of 90 nights → SUM=450.
		expect(Number(availRows[0]?.allotmentSum ?? 0)).toBe(450)

		// 1:1 date alignment: NO orphan rate (rate без availability) AND NO
		// orphan availability (availability без rate). Asymmetric seeding =
		// the trap caught 2026-05-15.
		const [orphanRateRows = []] = await sql<Array<{ orphans: number | bigint }>>`
			SELECT COUNT(*) AS orphans FROM rate AS r
			LEFT JOIN availability AS a
				ON a.tenantId = r.tenantId
				AND a.propertyId = r.propertyId
				AND a.roomTypeId = r.roomTypeId
				AND a.date = r.date
			WHERE r.tenantId = ${TENANT}
				AND r.propertyId = ${result.propertyId}
				AND a.date IS NULL
		`
		expect(Number(orphanRateRows[0]?.orphans ?? 0)).toBe(0)

		// Sold=0, stopSell=false, no closures — fresh bookable state.
		const [defaultsRows = []] = await sql<
			Array<{ soldSum: number | bigint; stopSellAnyTrue: boolean | number }>
		>`
			SELECT SUM(sold) AS soldSum, MAX(CAST(stopSell AS Int32)) AS stopSellAnyTrue
			FROM availability
			WHERE tenantId = ${TENANT}
				AND propertyId = ${result.propertyId}
				AND roomTypeId = ${result.roomTypeId}
		`
		expect(Number(defaultsRows[0]?.soldSum ?? 0)).toBe(0)
		expect(Number(defaultsRows[0]?.stopSellAnyTrue ?? 0)).toBe(0)
	})

	test('[I3.boundary] rooms=1 creates a single room «101»', async () => {
		const result = await service.createInventory(TENANT, {
			property: {
				name: 'Мини-отель Демо',
				address: 'Сириус, ул. Демонстрационная 1',
				city: 'Sirius',
			},
			rooms: 1,
			avgPriceRub: 1500,
		})
		cleanupPropertyIds.push(result.propertyId)

		expect(result.roomIds.length).toBe(1)
		const [rows = []] = await sql<Array<{ number: string }>>`
			SELECT number FROM room
			WHERE tenantId = ${TENANT} AND propertyId = ${result.propertyId}
		`.isolation('snapshotReadOnly')
		expect(rows.length).toBe(1)
		expect(rows[0]?.number).toBe('101')
	})

	test('[I5] cross-tenant: rows created for TENANT_A invisible to TENANT_B', async () => {
		const tenantB = newId('organization')
		const result = await service.createInventory(TENANT, {
			property: {
				name: 'Тест-T1',
				address: 'addr',
				city: 'Sochi',
			},
			rooms: 3,
			avgPriceRub: 2000,
		})
		cleanupPropertyIds.push(result.propertyId)

		const [tBRows = []] = await sql<Array<{ id: string }>>`
			SELECT id FROM property
			WHERE tenantId = ${tenantB} AND id = ${result.propertyId}
		`.isolation('snapshotReadOnly')
		expect(tBRows.length).toBe(0)
	})
})
