/**
 * Availability repo — YDB integration tests.
 *
 * Business invariants:
 *   1. `sold` is NEVER written by the availability API — only booking service
 *      touches it. bulkUpsert preserves existing `sold` on overwrite.
 *   2. bulkUpsert preserves `createdAt` on overwrite, advances `updatedAt`.
 *   3. Restriction booleans (closedToArrival/closedToDeparture/stopSell)
 *      roundtrip exactly — no silent coercion.
 *   4. Nullable LOS fields (minStay/maxStay) null-patch correctly.
 *   5. Tenant isolation on listRange, getOne, deleteOne.
 *   6. PK separation: different roomType+date = independent rows.
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test, jest } from 'bun:test'

jest.setTimeout(60_000)

import { dateFromIso, toTs } from '../../db/ydb-helpers.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createAvailabilityRepo } from './availability.repo.ts'

const TENANT_A = newId('organization')
const TENANT_B = newId('organization')
const PROP_A = newId('property')
const RT_A = newId('roomType')
const RT_B = newId('roomType')

describe('availability.repo', () => {
	let repo: ReturnType<typeof createAvailabilityRepo>
	const createdCells: Array<{
		tenantId: string
		propertyId: string
		roomTypeId: string
		date: string
	}> = []

	beforeAll(async () => {
		await setupTestDb()
		repo = createAvailabilityRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const c of createdCells) {
			await sql`
				DELETE FROM availability
				WHERE tenantId = ${c.tenantId}
					AND propertyId = ${c.propertyId}
					AND roomTypeId = ${c.roomTypeId}
					AND date = CAST(${c.date} AS Date)
			`
		}
		await teardownTestDb()
	})

	const track = (tenantId: string, propertyId: string, roomTypeId: string, dates: string[]) => {
		for (const d of dates) createdCells.push({ tenantId, propertyId, roomTypeId, date: d })
	}

	test('bulkUpsert: inserts + defaults (sold=0, false restrictions, null LOS)', async () => {
		const items = await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [
				{
					date: '2026-07-01',
					allotment: 10,
					closedToArrival: false,
					closedToDeparture: false,
					stopSell: false,
				},
				{
					date: '2026-07-02',
					allotment: 12,
					closedToArrival: false,
					closedToDeparture: false,
					stopSell: false,
				},
			],
		})
		track(TENANT_A, PROP_A, RT_A, ['2026-07-01', '2026-07-02'])

		expect(items).toHaveLength(2)
		for (const a of items) {
			expect(a.sold).toBe(0)
			expect(a.closedToArrival).toBe(false)
			expect(a.closedToDeparture).toBe(false)
			expect(a.stopSell).toBe(false)
			expect(a.minStay).toBeNull()
			expect(a.maxStay).toBeNull()
		}
		expect(items.map((r) => r.date)).toEqual(['2026-07-01', '2026-07-02'])
		expect(items[0]?.allotment).toBe(10)
		expect(items[1]?.allotment).toBe(12)
	})

	test('bulkUpsert preserves `sold` on overwrite', async () => {
		// First insert with sold=0.
		await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [{ date: '2026-08-01', allotment: 5 }],
		})
		track(TENANT_A, PROP_A, RT_A, ['2026-08-01'])

		// Simulate a booking service having advanced sold directly.
		const sql = getTestSql()
		await sql`
			UPDATE availability SET sold = 3
			WHERE tenantId = ${TENANT_A}
				AND propertyId = ${PROP_A}
				AND roomTypeId = ${RT_A}
				AND date = CAST('2026-08-01' AS Date)
		`

		// Re-upsert with different allotment — sold must remain 3.
		const second = await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [{ date: '2026-08-01', allotment: 20 }],
		})
		expect(second[0]?.allotment).toBe(20)
		expect(second[0]?.sold).toBe(3)
	})

	test('bulkUpsert: restrictions roundtrip + null LOS patch', async () => {
		const items = await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [
				{
					date: '2026-09-15',
					allotment: 8,
					minStay: 3,
					maxStay: 14,
					closedToArrival: true,
					closedToDeparture: false,
					stopSell: false,
				},
			],
		})
		track(TENANT_A, PROP_A, RT_A, ['2026-09-15'])
		expect(items[0]?.minStay).toBe(3)
		expect(items[0]?.maxStay).toBe(14)
		expect(items[0]?.closedToArrival).toBe(true)

		// Clear LOS restrictions with explicit null.
		const cleared = await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [
				{
					date: '2026-09-15',
					allotment: 8,
					minStay: null,
					maxStay: null,
					closedToArrival: false,
					closedToDeparture: false,
					stopSell: true,
				},
			],
		})
		expect(cleared[0]?.minStay).toBeNull()
		expect(cleared[0]?.maxStay).toBeNull()
		expect(cleared[0]?.stopSell).toBe(true)
		expect(cleared[0]?.closedToArrival).toBe(false)
	})

	test('tenant isolation: listRange from wrong tenant returns []', async () => {
		await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [{ date: '2026-10-01', allotment: 1 }],
		})
		track(TENANT_A, PROP_A, RT_A, ['2026-10-01'])

		const leak = await repo.listRange(TENANT_B, PROP_A, RT_A, {
			from: '2026-10-01',
			to: '2026-10-01',
		})
		expect(leak).toEqual([])
	})

	test('PK separation: different roomType + same date → independent rows', async () => {
		await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [{ date: '2026-11-01', allotment: 5 }],
		})
		await repo.bulkUpsert(TENANT_A, PROP_A, RT_B, {
			rates: [{ date: '2026-11-01', allotment: 7 }],
		})
		track(TENANT_A, PROP_A, RT_A, ['2026-11-01'])
		track(TENANT_A, PROP_A, RT_B, ['2026-11-01'])

		const a = await repo.getOne(TENANT_A, PROP_A, RT_A, '2026-11-01')
		const b = await repo.getOne(TENANT_A, PROP_A, RT_B, '2026-11-01')
		expect(a?.allotment).toBe(5)
		expect(b?.allotment).toBe(7)
	})

	test('deleteOne: first true, second false', async () => {
		await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [{ date: '2027-01-01', allotment: 1 }],
		})
		expect(await repo.deleteOne(TENANT_A, PROP_A, RT_A, '2027-01-01')).toBe(true)
		expect(await repo.deleteOne(TENANT_A, PROP_A, RT_A, '2027-01-01')).toBe(false)
	})

	test('tenant isolation: getOne + deleteOne from wrong tenant are no-ops', async () => {
		await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [{ date: '2027-02-05', allotment: 3 }],
		})
		track(TENANT_A, PROP_A, RT_A, ['2027-02-05'])

		expect(await repo.getOne(TENANT_B, PROP_A, RT_A, '2027-02-05')).toBeNull()
		expect(await repo.deleteOne(TENANT_B, PROP_A, RT_A, '2027-02-05')).toBe(false)
		// Own-tenant row must still be intact after failed cross-tenant probes.
		expect((await repo.getOne(TENANT_A, PROP_A, RT_A, '2027-02-05'))?.allotment).toBe(3)
	})

	test('bulkUpsert overwrite: createdAt preserved, updatedAt strictly advances', async () => {
		const [first] = await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [{ date: '2027-03-10', allotment: 4 }],
		})
		track(TENANT_A, PROP_A, RT_A, ['2027-03-10'])

		await new Promise((r) => setTimeout(r, 10))
		const [second] = await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [{ date: '2027-03-10', allotment: 9 }],
		})
		expect(second?.createdAt).toBe(first?.createdAt)
		expect(new Date(second?.updatedAt ?? '').getTime()).toBeGreaterThan(
			new Date(first?.updatedAt ?? '').getTime(),
		)
	})

	test('closedToDeparture roundtrip (explicit coverage of the other flag)', async () => {
		const [row] = await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [
				{
					date: '2027-04-15',
					allotment: 2,
					closedToArrival: false,
					closedToDeparture: true,
					stopSell: false,
				},
			],
		})
		track(TENANT_A, PROP_A, RT_A, ['2027-04-15'])
		expect(row?.closedToDeparture).toBe(true)
		expect(row?.closedToArrival).toBe(false)
	})

	test('listRange: ORDER BY date ASC + inclusive bounds on exact from/to', async () => {
		const dates = ['2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04']
		await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: dates.map((d) => ({ date: d, allotment: 1 })),
		})
		track(TENANT_A, PROP_A, RT_A, dates)

		// Insert in reverse order-ish to guard against coincidental pre-sort.
		const middle = await repo.listRange(TENANT_A, PROP_A, RT_A, {
			from: '2027-05-01',
			to: '2027-05-04',
		})
		expect(middle.map((r) => r.date)).toEqual(dates)

		// Tight bounds: from == to returns exactly one row.
		const single = await repo.listRange(TENANT_A, PROP_A, RT_A, {
			from: '2027-05-02',
			to: '2027-05-02',
		})
		expect(single.map((r) => r.date)).toEqual(['2027-05-02'])
	})

	test('listRange: empty tenant with pre-seeded noise in other tenant returns []', async () => {
		// Seed A so a broken tenant filter would surface these rows.
		await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [{ date: '2027-06-01', allotment: 1 }],
		})
		track(TENANT_A, PROP_A, RT_A, ['2027-06-01'])

		const empty = await repo.listRange(
			'org_absolutelynothing00000000',
			'prop_absolutelynothing000000',
			'rmt_absolutelynothing0000000',
			{ from: '2027-06-01', to: '2027-06-01' },
		)
		expect(empty).toEqual([])
	})

	// ============================================================================
	// [OB*] Overbooking-prevention canon (2026-05-18) — `oversellDelta` column
	// (Apaleo «Allowed Overbooking» canon) + bulkUpsert capacity-vs-sold guard.
	// ============================================================================

	test('[OB1] oversellDelta defaults к 0 on first insert (column NULL → coerce 0)', async () => {
		const [row] = await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [{ date: '2028-01-10', allotment: 5 }],
		})
		track(TENANT_A, PROP_A, RT_A, ['2028-01-10'])
		expect(row?.oversellDelta).toBe(0)
	})

	test('[OB2] oversellDelta positive value roundtrip (operator-set oversell)', async () => {
		const [row] = await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [{ date: '2028-02-10', allotment: 5, oversellDelta: 2 }],
		})
		track(TENANT_A, PROP_A, RT_A, ['2028-02-10'])
		expect(row?.oversellDelta).toBe(2)
	})

	test('[OB3] oversellDelta negative value roundtrip (operator pulls units offline)', async () => {
		const [row] = await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [{ date: '2028-03-10', allotment: 5, oversellDelta: -1 }],
		})
		track(TENANT_A, PROP_A, RT_A, ['2028-03-10'])
		expect(row?.oversellDelta).toBe(-1)
	})

	test('[OB4] oversellDelta preserved on overwrite when omitted from payload', async () => {
		await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [{ date: '2028-04-10', allotment: 5, oversellDelta: 3 }],
		})
		track(TENANT_A, PROP_A, RT_A, ['2028-04-10'])
		// Second upsert without oversellDelta should preserve the prior value.
		const [row] = await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [{ date: '2028-04-10', allotment: 8 }],
		})
		expect(row?.oversellDelta).toBe(3)
		expect(row?.allotment).toBe(8)
	})

	test('[OB5] bulkUpsert rejects allotment + oversellDelta < sold (Gap C — capacity-below-sold)', async () => {
		// Seed allotment=5, then manually bump sold к 4 (simulating committed bookings).
		const sql = getTestSql()
		const now = toTs(new Date())
		await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [{ date: '2028-05-10', allotment: 5 }],
		})
		track(TENANT_A, PROP_A, RT_A, ['2028-05-10'])
		await sql`
			UPDATE availability SET sold = 4, updatedAt = ${now}
			WHERE tenantId = ${TENANT_A} AND propertyId = ${PROP_A}
				AND roomTypeId = ${RT_A} AND date = ${dateFromIso('2028-05-10')}
		`

		// Operator tries к drop allotment к 3 — would leave 4 phantom bookings over.
		await expect(
			repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
				rates: [{ date: '2028-05-10', allotment: 3 }],
			}),
		).rejects.toThrow(/Cannot reduce capacity below sold/i)

		// State unchanged (allotment 5, sold 4 still).
		const r = await repo.getOne(TENANT_A, PROP_A, RT_A, '2028-05-10')
		expect(r?.allotment).toBe(5)
		expect(r?.sold).toBe(4)
	})

	test('[OB6] bulkUpsert: oversellDelta rescues allotment reduction (allotment+oversell >= sold)', async () => {
		const sql = getTestSql()
		const now = toTs(new Date())
		await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [{ date: '2028-06-10', allotment: 5 }],
		})
		track(TENANT_A, PROP_A, RT_A, ['2028-06-10'])
		await sql`
			UPDATE availability SET sold = 4, updatedAt = ${now}
			WHERE tenantId = ${TENANT_A} AND propertyId = ${PROP_A}
				AND roomTypeId = ${RT_A} AND date = ${dateFromIso('2028-06-10')}
		`

		// Drop allotment к 3 BUT bump oversellDelta к +1 → effective 4 == sold OK.
		const [row] = await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [{ date: '2028-06-10', allotment: 3, oversellDelta: 1 }],
		})
		expect(row?.allotment).toBe(3)
		expect(row?.oversellDelta).toBe(1)
		expect(row?.sold).toBe(4)
	})

	test('[OB7] bulkUpsert: exact boundary allotment+oversellDelta === sold accepted', async () => {
		const sql = getTestSql()
		const now = toTs(new Date())
		await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [{ date: '2028-07-10', allotment: 5 }],
		})
		track(TENANT_A, PROP_A, RT_A, ['2028-07-10'])
		await sql`
			UPDATE availability SET sold = 5, updatedAt = ${now}
			WHERE tenantId = ${TENANT_A} AND propertyId = ${PROP_A}
				AND roomTypeId = ${RT_A} AND date = ${dateFromIso('2028-07-10')}
		`

		// Same allotment as sold — effective = sold, boundary OK (no overshoot).
		const [row] = await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, {
			rates: [{ date: '2028-07-10', allotment: 5 }],
		})
		expect(row?.allotment).toBe(5)
		expect(row?.sold).toBe(5)
	})

	test('[OB8] oversellDelta Zod bounds: out-of-range (-1001) rejected at schema layer', async () => {
		// Schema bounds are -1000..+1000 per shared/availability.ts. Caller-side
		// Zod parse should reject before hitting repo. Verify via service-level
		// schema parse — repo bypass would be misuse.
		const { availabilityBulkUpsertInput } = await import('@horeca/shared')
		const result = availabilityBulkUpsertInput.safeParse({
			rates: [{ date: '2028-08-10', allotment: 5, oversellDelta: -1001 }],
		})
		expect(result.success).toBe(false)
	})
})
