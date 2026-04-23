/**
 * RatePlan repo — YDB integration tests.
 *
 * Business invariants under test:
 *   1. Tenant isolation absolute on get/list/update/delete.
 *   2. Code uniqueness within (tenantId, propertyId) — app-level enforced in
 *      sql.begin (YDB can't add UNIQUE indexes after CREATE TABLE).
 *   3. Code uniqueness does NOT cross properties (same code OK in prop A and B).
 *   4. Code uniqueness does NOT cross tenants.
 *   5. Update to conflicting code raises RatePlanCodeTakenError, leaves row intact.
 *   6. Renaming to own current code is a no-op (not a conflict with self).
 *   7. Null-patch semantic on nullable fields (cancellationHours, maxStay).
 *   8. Update preserves id, tenantId, propertyId, roomTypeId, createdAt.
 *   9. updatedAt strictly monotonic, ms precision preserved.
 *  10. Defaults: isActive=true, isDefault=false, isRefundable=true,
 *      mealsIncluded='none', minStay=1, currency='RUB'.
 *  11. Delete frees the code for reuse in the same property.
 *  12. listByProperty with roomTypeId filter narrows correctly.
 *
 * Requires local YDB (docker-compose up ydb).
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { RatePlanCodeTakenError } from '../../errors/domain.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createRatePlanRepo } from './ratePlan.repo.ts'

const TENANT_A = newId('organization')
const TENANT_B = newId('organization')
const PROP_A1 = newId('property')
const PROP_A2 = newId('property')
const PROP_B1 = newId('property')
const RT_A1 = newId('roomType')
const RT_A1_B = newId('roomType')
const RT_A2 = newId('roomType')
const RT_B1 = newId('roomType')

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

describe('ratePlan.repo', { tags: ['db'], timeout: 30_000 }, () => {
	let repo: ReturnType<typeof createRatePlanRepo>
	const createdIds: Array<{ tenantId: string; id: string }> = []

	beforeAll(async () => {
		await setupTestDb()
		repo = createRatePlanRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const { tenantId, id } of createdIds) {
			await sql`DELETE FROM ratePlan WHERE tenantId = ${tenantId} AND id = ${id}`
		}
		await teardownTestDb()
	})

	test('create: persists input + defaults, roundtrip exact', async () => {
		const rp = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'Best Available Rate',
			code: 'BAR',
			isDefault: true,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'breakfast',
			minStay: 1,
			currency: 'RUB',
		})
		createdIds.push({ tenantId: TENANT_A, id: rp.id })

		expect(rp.id).toMatch(/^rp_[0-9a-z]{26}$/)
		expect(rp.tenantId).toBe(TENANT_A)
		expect(rp.propertyId).toBe(PROP_A1)
		expect(rp.roomTypeId).toBe(RT_A1)
		expect(rp.name).toBe('Best Available Rate')
		expect(rp.code).toBe('BAR')
		expect(rp.isDefault).toBe(true)
		expect(rp.isRefundable).toBe(true)
		expect(rp.cancellationHours).toBe(24)
		expect(rp.mealsIncluded).toBe('breakfast')
		expect(rp.minStay).toBe(1)
		expect(rp.maxStay).toBeNull()
		expect(rp.currency).toBe('RUB')
		expect(rp.isActive).toBe(true)
		expect(rp.createdAt).toMatch(ISO_DATETIME)
		expect(rp.createdAt).toBe(rp.updatedAt)

		const fetched = await repo.getById(TENANT_A, rp.id)
		expect(fetched).toEqual(rp)
	})

	test('create: nullable fields default to null when omitted', async () => {
		const rp = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'Minimal Plan',
			code: 'MIN',
			isDefault: false,
			isRefundable: false,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		createdIds.push({ tenantId: TENANT_A, id: rp.id })

		expect(rp.cancellationHours).toBeNull()
		expect(rp.maxStay).toBeNull()
		expect(rp.isRefundable).toBe(false)
	})

	test('UNIQUE code: duplicate in same property → RatePlanCodeTakenError', async () => {
		const first = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'Flex',
			code: 'UNQ-BAR',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 48,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		createdIds.push({ tenantId: TENANT_A, id: first.id })

		await expect(
			repo.create(TENANT_A, PROP_A1, RT_A1, {
				roomTypeId: RT_A1,
				name: 'Duplicate',
				code: 'UNQ-BAR',
				isDefault: false,
				isRefundable: true,
				cancellationHours: 48,
				mealsIncluded: 'none',
				minStay: 1,
				currency: 'RUB',
			}),
		).rejects.toBeInstanceOf(RatePlanCodeTakenError)
	})

	test('UNIQUE code: same code allowed across different properties of same tenant', async () => {
		const a = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'BarA1',
			code: 'CROSS-PROP',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		const b = await repo.create(TENANT_A, PROP_A2, RT_A2, {
			roomTypeId: RT_A2,
			name: 'BarA2',
			code: 'CROSS-PROP',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		createdIds.push({ tenantId: TENANT_A, id: a.id }, { tenantId: TENANT_A, id: b.id })
		expect(a.propertyId).toBe(PROP_A1)
		expect(b.propertyId).toBe(PROP_A2)
	})

	test('UNIQUE code: same code allowed across different tenants', async () => {
		const a = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'TenA',
			code: 'CROSS-TEN',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		const b = await repo.create(TENANT_B, PROP_B1, RT_B1, {
			roomTypeId: RT_B1,
			name: 'TenB',
			code: 'CROSS-TEN',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		createdIds.push({ tenantId: TENANT_A, id: a.id }, { tenantId: TENANT_B, id: b.id })
	})

	test('UNIQUE code: update to conflicting code raises, leaves row intact', async () => {
		const a = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'SwapA',
			code: 'SWAP-A',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		const b = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'SwapB',
			code: 'SWAP-B',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		createdIds.push({ tenantId: TENANT_A, id: a.id }, { tenantId: TENANT_A, id: b.id })

		await expect(repo.update(TENANT_A, b.id, { code: 'SWAP-A' })).rejects.toBeInstanceOf(
			RatePlanCodeTakenError,
		)
		expect((await repo.getById(TENANT_A, a.id))?.code).toBe('SWAP-A')
		expect((await repo.getById(TENANT_A, b.id))?.code).toBe('SWAP-B')
	})

	test('UNIQUE code: renaming to own current code is a no-op', async () => {
		const a = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'Self',
			code: 'SELF-REF',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		createdIds.push({ tenantId: TENANT_A, id: a.id })

		const patched = await repo.update(TENANT_A, a.id, { code: 'SELF-REF', name: 'SelfRenamed' })
		expect(patched?.code).toBe('SELF-REF')
		expect(patched?.name).toBe('SelfRenamed')
	})

	test('UNIQUE code: after delete, freed code can be reused in same property', async () => {
		const a = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'Reuse',
			code: 'REUSE-CODE',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		expect(await repo.delete(TENANT_A, a.id)).toBe(true)

		const b = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'Replacement',
			code: 'REUSE-CODE',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		createdIds.push({ tenantId: TENANT_A, id: b.id })
		expect(b.id).not.toBe(a.id)
	})

	test('null-patch: undefined omits, null clears cancellationHours+maxStay', async () => {
		const a = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'NullPatch',
			code: 'NULL-PATCH',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 48,
			mealsIncluded: 'none',
			minStay: 1,
			maxStay: 30,
			currency: 'RUB',
		})
		createdIds.push({ tenantId: TENANT_A, id: a.id })

		const omitted = await repo.update(TENANT_A, a.id, { name: 'Renamed' })
		expect(omitted?.cancellationHours).toBe(48)
		expect(omitted?.maxStay).toBe(30)

		const cleared = await repo.update(TENANT_A, a.id, { cancellationHours: null, maxStay: null })
		expect(cleared?.cancellationHours).toBeNull()
		expect(cleared?.maxStay).toBeNull()

		const fetched = await repo.getById(TENANT_A, a.id)
		expect(fetched?.cancellationHours).toBeNull()
		expect(fetched?.maxStay).toBeNull()

		const reset = await repo.update(TENANT_A, a.id, { cancellationHours: 72, maxStay: 14 })
		expect(reset?.cancellationHours).toBe(72)
		expect(reset?.maxStay).toBe(14)
	})

	test('update preserves immutables (id, tenantId, propertyId, roomTypeId, createdAt)', async () => {
		const a = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'Immut',
			code: 'IMMUT',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		createdIds.push({ tenantId: TENANT_A, id: a.id })

		const patched = await repo.update(TENANT_A, a.id, { name: 'Renamed', minStay: 2 })
		expect(patched?.id).toBe(a.id)
		expect(patched?.tenantId).toBe(TENANT_A)
		expect(patched?.propertyId).toBe(PROP_A1)
		expect(patched?.roomTypeId).toBe(RT_A1)
		expect(patched?.createdAt).toBe(a.createdAt)
		expect(patched?.name).toBe('Renamed')
		expect(patched?.minStay).toBe(2)
	})

	test('updatedAt strictly monotonic; ms precision preserved', async () => {
		const a = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'Time',
			code: 'TIME',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		createdIds.push({ tenantId: TENANT_A, id: a.id })

		await new Promise((r) => setTimeout(r, 10))
		const patched = await repo.update(TENANT_A, a.id, { name: 'Time2' })
		expect(new Date(patched!.updatedAt).getTime()).toBeGreaterThan(new Date(a.updatedAt).getTime())
		const fetched = await repo.getById(TENANT_A, a.id)
		expect(fetched?.updatedAt).toBe(patched?.updatedAt)
	})

	test('tenant isolation: update and delete from wrong tenant are no-ops', async () => {
		const a = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'TenantGuard',
			code: 'TG',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		createdIds.push({ tenantId: TENANT_A, id: a.id })

		expect(await repo.update(TENANT_B, a.id, { name: 'Hijacked' })).toBeNull()
		expect(await repo.delete(TENANT_B, a.id)).toBe(false)
		const still = await repo.getById(TENANT_A, a.id)
		expect(still).toEqual(a)
	})

	test('listByProperty: filters by tenant + propertyId; roomTypeId narrows', async () => {
		const p1rt1 = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'P1RT1',
			code: 'LIST-1',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		const p1rt1b = await repo.create(TENANT_A, PROP_A1, RT_A1_B, {
			roomTypeId: RT_A1_B,
			name: 'P1RT1B',
			code: 'LIST-2',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		const p2 = await repo.create(TENANT_A, PROP_A2, RT_A2, {
			roomTypeId: RT_A2,
			name: 'P2',
			code: 'LIST-3',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		const bTenant = await repo.create(TENANT_B, PROP_B1, RT_B1, {
			roomTypeId: RT_B1,
			name: 'B',
			code: 'LIST-4',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		createdIds.push(
			{ tenantId: TENANT_A, id: p1rt1.id },
			{ tenantId: TENANT_A, id: p1rt1b.id },
			{ tenantId: TENANT_A, id: p2.id },
			{ tenantId: TENANT_B, id: bTenant.id },
		)

		const prop1 = await repo.listByProperty(TENANT_A, PROP_A1, { includeInactive: false })
		const prop1Ids = new Set(prop1.map((r) => r.id))
		expect(prop1Ids.has(p1rt1.id)).toBe(true)
		expect(prop1Ids.has(p1rt1b.id)).toBe(true)
		expect(prop1Ids.has(p2.id)).toBe(false)
		expect(prop1Ids.has(bTenant.id)).toBe(false)

		const rt1Only = await repo.listByProperty(TENANT_A, PROP_A1, {
			includeInactive: false,
			roomTypeId: RT_A1,
		})
		expect(new Set(rt1Only.map((r) => r.id)).has(p1rt1.id)).toBe(true)
		expect(new Set(rt1Only.map((r) => r.id)).has(p1rt1b.id)).toBe(false)

		// Cross-tenant probe on same propertyId must return empty.
		const leak = await repo.listByProperty(TENANT_B, PROP_A1, { includeInactive: false })
		expect(leak).toEqual([])
	})

	test('delete: idempotent (first true, second false)', async () => {
		const a = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'Del',
			code: 'DEL',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		expect(await repo.delete(TENANT_A, a.id)).toBe(true)
		expect(await repo.getById(TENANT_A, a.id)).toBeNull()
		expect(await repo.delete(TENANT_A, a.id)).toBe(false)
	})

	test('tenant isolation: getById with wrong tenant returns null (no cross-tenant leak)', async () => {
		const a = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'GetLeak',
			code: 'GET-LEAK',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		createdIds.push({ tenantId: TENANT_A, id: a.id })

		expect(await repo.getById(TENANT_B, a.id)).toBeNull()
		expect(await repo.getById('org_nonexistent_00000000000000', a.id)).toBeNull()
		// Own tenant still succeeds (guard didn't over-reject).
		expect(await repo.getById(TENANT_A, a.id)).not.toBeNull()
	})

	test('mealsIncluded: all 5 enum values roundtrip exactly', async () => {
		const values = ['none', 'breakfast', 'halfBoard', 'fullBoard', 'allInclusive'] as const
		for (const meal of values) {
			const rp = await repo.create(TENANT_A, PROP_A1, RT_A1, {
				roomTypeId: RT_A1,
				name: `Meal-${meal}`,
				code: `MEAL-${meal.toUpperCase()}`,
				isDefault: false,
				isRefundable: true,
				cancellationHours: 24,
				mealsIncluded: meal,
				minStay: 1,
				currency: 'RUB',
			})
			createdIds.push({ tenantId: TENANT_A, id: rp.id })
			expect(rp.mealsIncluded).toBe(meal)
			const fetched = await repo.getById(TENANT_A, rp.id)
			expect(fetched?.mealsIncluded).toBe(meal)
		}
	})

	test('listByProperty includeInactive: deactivated plans hidden by default, shown on opt-in', async () => {
		const active = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'Active',
			code: 'INACT-ACTIVE',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		const deactivated = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'Deactivated',
			code: 'INACT-DEACT',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		createdIds.push(
			{ tenantId: TENANT_A, id: active.id },
			{ tenantId: TENANT_A, id: deactivated.id },
		)
		await repo.update(TENANT_A, deactivated.id, { isActive: false })

		const defaultList = await repo.listByProperty(TENANT_A, PROP_A1, { includeInactive: false })
		const defaultIds = new Set(defaultList.map((r) => r.id))
		expect(defaultIds.has(active.id)).toBe(true)
		expect(defaultIds.has(deactivated.id)).toBe(false)
		for (const r of defaultList) expect(r.isActive).toBe(true)

		const allList = await repo.listByProperty(TENANT_A, PROP_A1, { includeInactive: true })
		const allIds = new Set(allList.map((r) => r.id))
		expect(allIds.has(active.id)).toBe(true)
		expect(allIds.has(deactivated.id)).toBe(true)
	})

	test('listByProperty: empty tenant returns [] even with noise in other tenants', async () => {
		// Pre-seed noise in TENANT_A so a broken tenant filter would surface rows.
		const noise = await repo.create(TENANT_A, PROP_A1, RT_A1, {
			roomTypeId: RT_A1,
			name: 'Noise',
			code: 'NOISE-RP',
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		createdIds.push({ tenantId: TENANT_A, id: noise.id })

		const empty = await repo.listByProperty(
			'org_absolutelynothing00000000',
			'prop_absolutelynothing0000000',
			{ includeInactive: false },
		)
		expect(empty).toEqual([])
	})
})
