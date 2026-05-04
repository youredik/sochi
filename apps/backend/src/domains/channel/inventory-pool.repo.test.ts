/**
 * Inventory pool repo — strict integration tests IPR1-IPR6 (M10 / A7.1.fix).
 *
 * Reuses M5 `availability` table (PK = tenantId × propertyId × roomTypeId × date).
 * Effective availability = `allotment - sold`. Reserve increments `sold`;
 * release decrements.
 *
 * Tests:
 *   - peek read-only
 *   - reserve success → remaining returned (allotment - sold updated)
 *   - reserve oversold → ok:false + available + attempted
 *   - reserve cell_missing
 *   - reserve stopSell honored
 *   - release symmetric к reserve
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { dateFromIso } from '../../db/ydb-helpers.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createInventoryPoolRepo } from './inventory-pool.repo.ts'

const RUN_ID = Date.now().toString(36)
const TENANT = `org_inv_${RUN_ID}`
const PROPERTY = 'prop_inv'
const ROOM_TYPE = 'rt_inv'
const DATE = '2027-06-15'
const STOP_DATE = '2027-06-16'

describe('inventory pool repo', { tags: ['db'], timeout: 30_000 }, () => {
	let repo: ReturnType<typeof createInventoryPoolRepo>

	beforeAll(async () => {
		await setupTestDb()
		repo = createInventoryPoolRepo(getTestSql())
		const sql = getTestSql()
		const now = new Date()
		// Seed cell with allotment=10 sold=0 stopSell=false.
		await sql`
			UPSERT INTO availability (
				tenantId, propertyId, roomTypeId, date,
				allotment, sold, closedToArrival, closedToDeparture, stopSell, createdAt, updatedAt
			) VALUES (
				${TENANT}, ${PROPERTY}, ${ROOM_TYPE}, ${dateFromIso(DATE)},
				${10}, ${0}, ${false}, ${false}, ${false}, ${now}, ${now}
			)
		`
		// Stop-sell cell.
		await sql`
			UPSERT INTO availability (
				tenantId, propertyId, roomTypeId, date,
				allotment, sold, closedToArrival, closedToDeparture, stopSell, createdAt, updatedAt
			) VALUES (
				${TENANT}, ${PROPERTY}, ${ROOM_TYPE}, ${dateFromIso(STOP_DATE)},
				${5}, ${0}, ${false}, ${false}, ${true}, ${now}, ${now}
			)
		`
	})

	afterAll(async () => {
		const sql = getTestSql()
		await sql`DELETE FROM availability WHERE tenantId = ${TENANT}`
		await teardownTestDb()
	})

	test('[IPR1] peek returns initial available + stopSell', async () => {
		const got = await repo.peek({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOM_TYPE,
			date: DATE,
		})
		expect(got).not.toBeNull()
		expect(got?.available).toBe(10)
		expect(got?.stopSell).toBe(false)
	})

	test('[IPR2] reserve 3 of 10 → ok with remaining=7', async () => {
		const r = await repo.reserve({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOM_TYPE,
			date: DATE,
			count: 3,
			source: 'channel',
			channelId: 'TL',
		})
		expect(r.ok).toBe(true)
		if (r.ok) expect(r.remaining).toBe(7)
		const after = await repo.peek({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOM_TYPE,
			date: DATE,
		})
		expect(after?.available).toBe(7)
	})

	test('[IPR3] reserve 999 of 7 → oversold + available=7 + attempted=999', async () => {
		const r = await repo.reserve({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOM_TYPE,
			date: DATE,
			count: 999,
			source: 'walk-in',
		})
		expect(r.ok).toBe(false)
		if (!r.ok) {
			expect(r.reason).toBe('oversold')
			expect(r.available).toBe(7)
			expect(r.attempted).toBe(999)
		}
	})

	test('[IPR4] reserve missing cell → cell_missing', async () => {
		const r = await repo.reserve({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: 'rt_does_not_exist',
			date: DATE,
			count: 1,
			source: 'channel',
		})
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.reason).toBe('cell_missing')
	})

	test('[IPR5] reserve stopSell cell → stop_sell', async () => {
		const r = await repo.reserve({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOM_TYPE,
			date: STOP_DATE,
			count: 1,
			source: 'channel',
		})
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.reason).toBe('stop_sell')
	})

	test('[IPR6] release adds count back to cell', async () => {
		const before = await repo.peek({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOM_TYPE,
			date: DATE,
		})
		expect(before?.available).toBe(7)
		const after = await repo.release({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOM_TYPE,
			date: DATE,
			count: 3,
		})
		expect(after.newAvailable).toBe(10)
	})
})
