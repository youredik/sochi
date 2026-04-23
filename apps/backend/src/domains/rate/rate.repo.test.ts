/**
 * Rate repo — YDB integration tests.
 *
 * Business invariants:
 *   1. Tenant isolation — rows insert with one tenant invisible to another.
 *   2. bulkUpsert is idempotent per-date: repeating same batch leaves one row
 *      per date, updatedAt advances, createdAt stays.
 *   3. amount roundtrips as a decimal string through the Int64 "micros"
 *      storage — "5000.50" in → "5000.5" out (trailing-zero normalization),
 *      "0.000001" → "0.000001".
 *   4. listRange honors inclusive [from, to] bounds and returns ORDER BY date.
 *   5. Date column uses `new YdbDate` wrap — without it, INSERT would fail
 *      with `ERROR(1030)` (the thing that blew up empirically 2026-04-23).
 *   6. deleteOne returns true exactly once.
 *   7. Separate (propertyId, roomTypeId) tuples do NOT collide on same date
 *      + same ratePlanId+tenantId (PK is all 5 columns).
 *
 * Requires local YDB.
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createRateRepo } from './rate.repo.ts'

const TENANT_A = newId('organization')
const TENANT_B = newId('organization')
const PROP_A = newId('property')
const PROP_B = newId('property')
const RT_A = newId('roomType')
const RT_B = newId('roomType')
const RP_A = newId('ratePlan')
const RP_B = newId('ratePlan')

describe('rate.repo', { tags: ['db'], timeout: 30_000 }, () => {
	let repo: ReturnType<typeof createRateRepo>
	const createdCells: Array<{
		tenantId: string
		propertyId: string
		roomTypeId: string
		ratePlanId: string
		date: string
	}> = []

	beforeAll(async () => {
		await setupTestDb()
		repo = createRateRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const c of createdCells) {
			await sql`
				DELETE FROM rate
				WHERE tenantId = ${c.tenantId}
					AND propertyId = ${c.propertyId}
					AND roomTypeId = ${c.roomTypeId}
					AND ratePlanId = ${c.ratePlanId}
					AND date = CAST(${c.date} AS Date)
			`
		}
		await teardownTestDb()
	})

	const trackCells = (
		tenantId: string,
		propertyId: string,
		roomTypeId: string,
		ratePlanId: string,
		dates: string[],
	) => {
		for (const d of dates) {
			createdCells.push({ tenantId, propertyId, roomTypeId, ratePlanId, date: d })
		}
	}

	test('bulkUpsert: inserts 3 dates, returns ordered range', async () => {
		const dates = ['2026-07-01', '2026-07-02', '2026-07-03']
		const result = await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, RP_A, {
			rates: [
				{ date: '2026-07-01', amount: '5000', currency: 'RUB' },
				{ date: '2026-07-02', amount: '5500.50', currency: 'RUB' },
				{ date: '2026-07-03', amount: '6000.000001', currency: 'RUB' },
			],
		})
		trackCells(TENANT_A, PROP_A, RT_A, RP_A, dates)

		expect(result).toHaveLength(3)
		expect(result.map((r) => r.date)).toEqual(dates)
		expect(result[0]?.amount).toBe('5000')
		expect(result[1]?.amount).toBe('5500.5')
		expect(result[2]?.amount).toBe('6000.000001')
		for (const r of result) {
			expect(r.tenantId).toBe(TENANT_A)
			expect(r.propertyId).toBe(PROP_A)
			expect(r.roomTypeId).toBe(RT_A)
			expect(r.ratePlanId).toBe(RP_A)
			expect(r.currency).toBe('RUB')
		}
	})

	test('bulkUpsert is idempotent: re-upsert updates amount, preserves createdAt', async () => {
		const firstRun = await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, RP_A, {
			rates: [{ date: '2026-08-15', amount: '4000', currency: 'RUB' }],
		})
		trackCells(TENANT_A, PROP_A, RT_A, RP_A, ['2026-08-15'])
		const first = firstRun[0]!
		expect(first.amount).toBe('4000')

		// Wait so updatedAt advances visibly
		await new Promise((r) => setTimeout(r, 10))

		const secondRun = await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, RP_A, {
			rates: [{ date: '2026-08-15', amount: '4500', currency: 'RUB' }],
		})
		const second = secondRun[0]!
		expect(second.amount).toBe('4500')
		// createdAt preserved on overwrite (audit trail invariant).
		expect(second.createdAt).toBe(first.createdAt)
		// updatedAt advances.
		expect(new Date(second.updatedAt).getTime()).toBeGreaterThan(
			new Date(first.updatedAt).getTime(),
		)

		// listRange still returns exactly one row for that date.
		const range = await repo.listRange(TENANT_A, PROP_A, RT_A, RP_A, {
			from: '2026-08-15',
			to: '2026-08-15',
		})
		expect(range).toHaveLength(1)
		expect(range[0]?.amount).toBe('4500')
	})

	test('tenant isolation: listRange from wrong tenant returns empty', async () => {
		await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, RP_A, {
			rates: [{ date: '2026-09-10', amount: '9000', currency: 'RUB' }],
		})
		trackCells(TENANT_A, PROP_A, RT_A, RP_A, ['2026-09-10'])

		const leakAttempt = await repo.listRange(TENANT_B, PROP_A, RT_A, RP_A, {
			from: '2026-09-10',
			to: '2026-09-10',
		})
		expect(leakAttempt).toEqual([])

		const ownSide = await repo.listRange(TENANT_A, PROP_A, RT_A, RP_A, {
			from: '2026-09-10',
			to: '2026-09-10',
		})
		expect(ownSide).toHaveLength(1)
	})

	test('PK separation: same date+plan+tenant but different roomType → independent rows', async () => {
		// Seed tenant_B with a different roomType so we can probe cross-roomType isolation.
		await repo.bulkUpsert(TENANT_B, PROP_B, RT_A, RP_B, {
			rates: [{ date: '2026-10-01', amount: '7000', currency: 'RUB' }],
		})
		await repo.bulkUpsert(TENANT_B, PROP_B, RT_B, RP_B, {
			rates: [{ date: '2026-10-01', amount: '8500', currency: 'RUB' }],
		})
		trackCells(TENANT_B, PROP_B, RT_A, RP_B, ['2026-10-01'])
		trackCells(TENANT_B, PROP_B, RT_B, RP_B, ['2026-10-01'])

		const rtA = await repo.listRange(TENANT_B, PROP_B, RT_A, RP_B, {
			from: '2026-10-01',
			to: '2026-10-01',
		})
		const rtB = await repo.listRange(TENANT_B, PROP_B, RT_B, RP_B, {
			from: '2026-10-01',
			to: '2026-10-01',
		})
		expect(rtA).toHaveLength(1)
		expect(rtA[0]?.amount).toBe('7000')
		expect(rtB).toHaveLength(1)
		expect(rtB[0]?.amount).toBe('8500')
	})

	test('listRange inclusive bounds + ORDER BY date ASC', async () => {
		const dates = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']
		await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, RP_A, {
			rates: dates.map((d) => ({ date: d, amount: '3000', currency: 'RUB' })),
		})
		trackCells(TENANT_A, PROP_A, RT_A, RP_A, dates)

		const middle = await repo.listRange(TENANT_A, PROP_A, RT_A, RP_A, {
			from: '2026-11-02',
			to: '2026-11-03',
		})
		expect(middle.map((r) => r.date)).toEqual(['2026-11-02', '2026-11-03'])

		const all = await repo.listRange(TENANT_A, PROP_A, RT_A, RP_A, {
			from: '2026-11-01',
			to: '2026-11-04',
		})
		expect(all.map((r) => r.date)).toEqual(dates)
	})

	test('getOne: exact PK lookup + cross-tenant null', async () => {
		await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, RP_A, {
			rates: [{ date: '2026-12-25', amount: '12000', currency: 'RUB' }],
		})
		trackCells(TENANT_A, PROP_A, RT_A, RP_A, ['2026-12-25'])

		const own = await repo.getOne(TENANT_A, PROP_A, RT_A, RP_A, '2026-12-25')
		expect(own?.amount).toBe('12000')
		expect(own?.date).toBe('2026-12-25')

		const wrongTenant = await repo.getOne(TENANT_B, PROP_A, RT_A, RP_A, '2026-12-25')
		expect(wrongTenant).toBeNull()

		const missingDate = await repo.getOne(TENANT_A, PROP_A, RT_A, RP_A, '2026-12-24')
		expect(missingDate).toBeNull()
	})

	test('deleteOne: first true, second false', async () => {
		await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, RP_A, {
			rates: [{ date: '2027-01-01', amount: '2000', currency: 'RUB' }],
		})

		expect(await repo.deleteOne(TENANT_A, PROP_A, RT_A, RP_A, '2027-01-01')).toBe(true)
		expect(await repo.getOne(TENANT_A, PROP_A, RT_A, RP_A, '2027-01-01')).toBeNull()
		expect(await repo.deleteOne(TENANT_A, PROP_A, RT_A, RP_A, '2027-01-01')).toBe(false)
	})

	test('amount micros precision: fractional values survive the Int64 round-trip', async () => {
		const cases = [
			{ in: '0.000001', out: '0.000001' },
			{ in: '1.2', out: '1.2' },
			{ in: '100000.999999', out: '100000.999999' },
		]
		for (const c of cases) {
			const date = `2027-03-${String(cases.indexOf(c) + 1).padStart(2, '0')}`
			const [r] = await repo.bulkUpsert(TENANT_A, PROP_A, RT_A, RP_A, {
				rates: [{ date, amount: c.in, currency: 'RUB' }],
			})
			trackCells(TENANT_A, PROP_A, RT_A, RP_A, [date])
			expect(r?.amount).toBe(c.out)
		}
	})
})
