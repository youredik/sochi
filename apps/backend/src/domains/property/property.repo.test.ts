/**
 * Property repo — YDB integration tests.
 *
 * Goal: hunt real bugs. Tests are strict — exact values, invariants, and
 * adversarial inputs (cross-tenant probes, deleted rows, field leakage).
 *
 * The core business rules we enforce:
 *   1. Tenant isolation is absolute — no read/write/delete crosses tenants.
 *   2. Update must preserve immutable fields (id, tenantId, createdAt).
 *   3. Null-patch semantic: `undefined` = no change, `null` = explicit clear.
 *   4. updatedAt is strictly monotonic on every successful update.
 *   5. includeInactive filter works independently of tenant filter.
 *   6. City enum roundtrips through YDB Utf8 unchanged (no coercion).
 *   7. Timezone default ('Europe/Moscow') applies only when omitted.
 *
 * Requires local YDB (docker-compose up ydb).
 */
import { propertyCreateInput } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createPropertyRepo } from './property.repo.ts'

const RUN_ID = Date.now().toString(36)
const TENANT_A = `org_test_a_${RUN_ID}`
const TENANT_B = `org_test_b_${RUN_ID}`
const TENANT_EMPTY = `org_test_empty_${RUN_ID}`

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

describe('property.repo', { tags: ['db'], timeout: 30_000 }, () => {
	let repo: ReturnType<typeof createPropertyRepo>
	const createdIds: Array<{ tenantId: string; id: string }> = []

	beforeAll(async () => {
		await setupTestDb()
		repo = createPropertyRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const { tenantId, id } of createdIds) {
			await sql`DELETE FROM property WHERE tenantId = ${tenantId} AND id = ${id}`
		}
		await teardownTestDb()
	})

	test('create: persists exact input and applies defaults (isActive=true, classificationId=null)', async () => {
		const input = {
			name: 'Villa Sochi',
			address: 'Kurortny prospekt 1',
			city: 'Sochi' as const,
			timezone: 'Europe/Moscow',
		}
		// Contract: input must satisfy shared zod schema.
		propertyCreateInput.parse(input)

		const created = await repo.create(TENANT_A, input)
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		// Typed id: starts with prop_ and is full typeid length (27 chars after prefix).
		expect(created.id).toMatch(/^prop_[0-9a-z]{26}$/)
		expect(created.tenantId).toBe(TENANT_A)
		expect(created.name).toBe('Villa Sochi')
		expect(created.address).toBe('Kurortny prospekt 1')
		expect(created.city).toBe('Sochi')
		expect(created.timezone).toBe('Europe/Moscow')
		expect(created.isActive).toBe(true)
		expect(created.classificationId).toBeNull()
		expect(created.createdAt).toMatch(ISO_DATETIME)
		expect(created.updatedAt).toMatch(ISO_DATETIME)
		expect(created.createdAt).toBe(created.updatedAt)

		// Roundtrip must return byte-identical row (no drift in DB layer).
		const fetched = await repo.getById(TENANT_A, created.id)
		expect(fetched).toEqual(created)
	})

	test('create: timezone default applies only when omitted (undefined → default, explicit value preserved)', async () => {
		const defaulted = await repo.create(TENANT_A, {
			name: 'TZ-default',
			address: 'A',
			city: 'Sochi',
		})
		createdIds.push({ tenantId: TENANT_A, id: defaulted.id })
		expect(defaulted.timezone).toBe('Europe/Moscow')

		const explicit = await repo.create(TENANT_A, {
			name: 'TZ-explicit',
			address: 'A',
			city: 'Sochi',
			timezone: 'Asia/Yekaterinburg',
		})
		createdIds.push({ tenantId: TENANT_A, id: explicit.id })
		expect(explicit.timezone).toBe('Asia/Yekaterinburg')
	})

	test('create: each call gets a distinct id (no collision under rapid creation)', async () => {
		const count = 5
		const ids = new Set<string>()
		for (let i = 0; i < count; i++) {
			const p = await repo.create(TENANT_A, {
				name: `Dup ${i}`,
				address: 'A',
				city: 'Sochi',
			})
			createdIds.push({ tenantId: TENANT_A, id: p.id })
			ids.add(p.id)
		}
		expect(ids.size).toBe(count)
	})

	test('create: all city enum values roundtrip unchanged', async () => {
		const cities = ['Sochi', 'Adler', 'Sirius', 'KrasnayaPolyana', 'Other'] as const
		for (const city of cities) {
			const p = await repo.create(TENANT_A, {
				name: `City-${city}`,
				address: 'A',
				city,
			})
			createdIds.push({ tenantId: TENANT_A, id: p.id })
			expect(p.city).toBe(city)
			const fetched = await repo.getById(TENANT_A, p.id)
			expect(fetched?.city).toBe(city)
		}
	})

	test('tenant isolation: getById with wrong tenant returns null (no cross-tenant leak)', async () => {
		const created = await repo.create(TENANT_A, {
			name: 'Apartment Adler',
			address: 'Lenin 99',
			city: 'Adler',
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		expect(await repo.getById(TENANT_B, created.id)).toBeNull()
		// Even a different but plausible tenant fails.
		expect(await repo.getById('org_nonexistent_foo', created.id)).toBeNull()
		// Own tenant still succeeds (delete guard wasn't broken).
		expect(await repo.getById(TENANT_A, created.id)).not.toBeNull()
	})

	test('tenant isolation: list filters by tenant and reveals no foreign rows', async () => {
		const a1 = await repo.create(TENANT_A, { name: 'A1', address: 'A', city: 'Sochi' })
		const a2 = await repo.create(TENANT_A, { name: 'A2', address: 'A', city: 'Sochi' })
		const b1 = await repo.create(TENANT_B, { name: 'B1', address: 'A', city: 'Sochi' })
		const b2 = await repo.create(TENANT_B, { name: 'B2', address: 'A', city: 'Sochi' })
		createdIds.push(
			{ tenantId: TENANT_A, id: a1.id },
			{ tenantId: TENANT_A, id: a2.id },
			{ tenantId: TENANT_B, id: b1.id },
			{ tenantId: TENANT_B, id: b2.id },
		)

		const aList = await repo.list(TENANT_A, { includeInactive: false })
		const aIds = new Set(aList.map((p) => p.id))
		expect(aIds.has(a1.id)).toBe(true)
		expect(aIds.has(a2.id)).toBe(true)
		expect(aIds.has(b1.id)).toBe(false)
		expect(aIds.has(b2.id)).toBe(false)
		// Every row must be stamped with the querying tenant.
		for (const p of aList) expect(p.tenantId).toBe(TENANT_A)

		const bList = await repo.list(TENANT_B, { includeInactive: false })
		const bIds = new Set(bList.map((p) => p.id))
		expect(bIds.has(b1.id)).toBe(true)
		expect(bIds.has(b2.id)).toBe(true)
		expect(bIds.has(a1.id)).toBe(false)
		expect(bIds.has(a2.id)).toBe(false)
		for (const p of bList) expect(p.tenantId).toBe(TENANT_B)
	})

	test('tenant isolation: empty tenant returns an empty array (not all rows)', async () => {
		// Pre-seed other tenants with rows so a broken filter would return them.
		const noise = await repo.create(TENANT_A, {
			name: 'Noise',
			address: 'A',
			city: 'Sochi',
		})
		createdIds.push({ tenantId: TENANT_A, id: noise.id })

		const list = await repo.list(TENANT_EMPTY, { includeInactive: false })
		expect(list).toEqual([])
	})

	test('tenant isolation: update with wrong tenant returns null and does not mutate target', async () => {
		const created = await repo.create(TENANT_A, {
			name: 'Original',
			address: 'Original Addr',
			city: 'Sochi',
			timezone: 'Europe/Moscow',
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		const leak = await repo.update(TENANT_B, created.id, {
			name: 'Hijacked',
			address: 'Hijacked Addr',
			classificationId: 'injected',
		})
		expect(leak).toBeNull()

		// Row must be byte-for-byte unchanged under real owner.
		const still = await repo.getById(TENANT_A, created.id)
		expect(still).toEqual(created)
	})

	test('tenant isolation: delete with wrong tenant returns false and does not remove', async () => {
		const created = await repo.create(TENANT_A, {
			name: 'DoNotDelete',
			address: 'A',
			city: 'Sochi',
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		expect(await repo.delete(TENANT_B, created.id)).toBe(false)
		const stillThere = await repo.getById(TENANT_A, created.id)
		expect(stillThere).toEqual(created)
	})

	test('update: preserves immutable fields (id, tenantId, createdAt) on every patch', async () => {
		const created = await repo.create(TENANT_A, {
			name: 'ImmutableTest',
			address: 'A',
			city: 'Sochi',
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		const patched = await repo.update(TENANT_A, created.id, {
			name: 'Renamed',
			address: 'New Addr',
			city: 'Adler',
		})
		expect(patched).not.toBeNull()
		expect(patched?.id).toBe(created.id)
		expect(patched?.tenantId).toBe(TENANT_A)
		expect(patched?.createdAt).toBe(created.createdAt)
		// Mutable fields changed as requested.
		expect(patched?.name).toBe('Renamed')
		expect(patched?.address).toBe('New Addr')
		expect(patched?.city).toBe('Adler')
	})

	test('update: updatedAt is strictly greater than previous value', async () => {
		const created = await repo.create(TENANT_A, {
			name: 'TimeTest',
			address: 'A',
			city: 'Sochi',
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		// Ensure clock advances past ms precision.
		await new Promise((r) => setTimeout(r, 10))

		const patched = await repo.update(TENANT_A, created.id, { name: 'TimeTest2' })
		expect(patched).not.toBeNull()
		expect(new Date(patched!.updatedAt).getTime()).toBeGreaterThan(
			new Date(created.updatedAt).getTime(),
		)
	})

	test('update: null-patch semantic — undefined preserves, null clears, string sets', async () => {
		const created = await repo.create(TENANT_A, {
			name: 'PatchSem',
			address: 'A',
			city: 'Sochi',
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })
		expect(created.classificationId).toBeNull()

		// Set from null → value.
		const set = await repo.update(TENANT_A, created.id, {
			classificationId: 'mini_hotel_3',
		})
		expect(set?.classificationId).toBe('mini_hotel_3')

		// Omit (undefined) → unchanged.
		const omitted = await repo.update(TENANT_A, created.id, { name: 'Renamed' })
		expect(omitted?.classificationId).toBe('mini_hotel_3')
		expect(omitted?.name).toBe('Renamed')

		// Set to different value.
		const reset = await repo.update(TENANT_A, created.id, {
			classificationId: 'apartment_4',
		})
		expect(reset?.classificationId).toBe('apartment_4')

		// Explicit null → cleared.
		const cleared = await repo.update(TENANT_A, created.id, { classificationId: null })
		expect(cleared?.classificationId).toBeNull()

		// Persisted across a fresh fetch (not just in merged return).
		const fetched = await repo.getById(TENANT_A, created.id)
		expect(fetched?.classificationId).toBeNull()
	})

	test('update: partial patch does not alter unspecified fields', async () => {
		const created = await repo.create(TENANT_A, {
			name: 'PartialInit',
			address: 'Initial Addr',
			city: 'Sochi',
			timezone: 'Europe/Moscow',
		})
		createdIds.push({ tenantId: TENANT_A, id: created.id })

		// Patch only name.
		const patched = await repo.update(TENANT_A, created.id, { name: 'PartialRenamed' })
		expect(patched?.name).toBe('PartialRenamed')
		expect(patched?.address).toBe('Initial Addr')
		expect(patched?.city).toBe('Sochi')
		expect(patched?.timezone).toBe('Europe/Moscow')
		expect(patched?.isActive).toBe(true)
	})

	test('update: on nonexistent row returns null (does not create)', async () => {
		const ghost = 'prop_00000000000000000000000000'
		const result = await repo.update(TENANT_A, ghost, { name: 'ShouldNotExist' })
		expect(result).toBeNull()
		// Verify no row was created (no UPSERT leak on missing key).
		expect(await repo.getById(TENANT_A, ghost)).toBeNull()
	})

	test('list: includeInactive=false hides soft-deactivated rows; =true shows them', async () => {
		const active = await repo.create(TENANT_A, {
			name: 'StayActive',
			address: 'A',
			city: 'Sochi',
		})
		const willBeInactive = await repo.create(TENANT_A, {
			name: 'GoingInactive',
			address: 'A',
			city: 'Sochi',
		})
		createdIds.push(
			{ tenantId: TENANT_A, id: active.id },
			{ tenantId: TENANT_A, id: willBeInactive.id },
		)

		await repo.update(TENANT_A, willBeInactive.id, { isActive: false })

		const activeOnly = await repo.list(TENANT_A, { includeInactive: false })
		const activeOnlyIds = new Set(activeOnly.map((p) => p.id))
		expect(activeOnlyIds.has(active.id)).toBe(true)
		expect(activeOnlyIds.has(willBeInactive.id)).toBe(false)
		for (const p of activeOnly) expect(p.isActive).toBe(true)

		const withInactive = await repo.list(TENANT_A, { includeInactive: true })
		const allIds = new Set(withInactive.map((p) => p.id))
		expect(allIds.has(active.id)).toBe(true)
		expect(allIds.has(willBeInactive.id)).toBe(true)
	})

	test('delete: first call returns true, second returns false (idempotent absence)', async () => {
		const created = await repo.create(TENANT_A, {
			name: 'DeleteTwice',
			address: 'A',
			city: 'Sochi',
		})
		// Not pushed — test exercises delete.

		expect(await repo.delete(TENANT_A, created.id)).toBe(true)
		expect(await repo.getById(TENANT_A, created.id)).toBeNull()
		expect(await repo.delete(TENANT_A, created.id)).toBe(false)
	})

	test('delete: on nonexistent id returns false (does not throw)', async () => {
		const ghost = 'prop_11111111111111111111111111'
		expect(await repo.delete(TENANT_A, ghost)).toBe(false)
	})

	// ---------------------------------------------------------------------------
	// M4e: tourismTaxRateBps (nullable Int32) roundtrip invariants
	// ---------------------------------------------------------------------------

	test('[TaxRT1] create without tourismTaxRateBps → null (opt-out default)', async () => {
		const p = await repo.create(TENANT_A, {
			name: 'No-tax Property',
			address: 'ул. Тестовая',
			city: 'Other',
		})
		expect(p.tourismTaxRateBps).toBeNull()
		const fetched = await repo.getById(TENANT_A, p.id)
		expect(fetched?.tourismTaxRateBps).toBeNull()
	})

	test('[TaxRT2] create with tourismTaxRateBps=200 (Sochi 2026) roundtrips exactly', async () => {
		const p = await repo.create(TENANT_A, {
			name: 'Sochi Resort',
			address: 'ул. Приморская',
			city: 'Sochi',
			tourismTaxRateBps: 200,
		})
		expect(p.tourismTaxRateBps).toBe(200)
		const fetched = await repo.getById(TENANT_A, p.id)
		expect(fetched?.tourismTaxRateBps).toBe(200)
	})

	test('[TaxRT3] update tourismTaxRateBps null → 200 sets value', async () => {
		const p = await repo.create(TENANT_A, {
			name: 'Upgrade',
			address: 'ул. Тестовая',
			city: 'Sochi',
		})
		const updated = await repo.update(TENANT_A, p.id, { tourismTaxRateBps: 200 })
		expect(updated?.tourismTaxRateBps).toBe(200)
		expect((await repo.getById(TENANT_A, p.id))?.tourismTaxRateBps).toBe(200)
	})

	test('[TaxRT4] update tourismTaxRateBps 200 → null CLEARS (null-patch semantic)', async () => {
		const p = await repo.create(TENANT_A, {
			name: 'Downgrade',
			address: 'ул. Тестовая',
			city: 'Sochi',
			tourismTaxRateBps: 200,
		})
		const cleared = await repo.update(TENANT_A, p.id, { tourismTaxRateBps: null })
		expect(cleared?.tourismTaxRateBps).toBeNull()
		expect((await repo.getById(TENANT_A, p.id))?.tourismTaxRateBps).toBeNull()
	})

	test('[TaxRT5] update WITHOUT tourismTaxRateBps in patch keeps current value (undefined = no change)', async () => {
		const p = await repo.create(TENANT_A, {
			name: 'Stable',
			address: 'ул. Тестовая',
			city: 'Sochi',
			tourismTaxRateBps: 200,
		})
		// Patch only name → rateBps stays 200.
		const updated = await repo.update(TENANT_A, p.id, { name: 'Stable-Renamed' })
		expect(updated?.tourismTaxRateBps).toBe(200)
	})

	test('[TaxRT6] future roadmap values 300 (2027) / 400 (2028) / 500 (2029 cap) all roundtrip', async () => {
		for (const bps of [300, 400, 500]) {
			const p = await repo.create(TENANT_A, {
				name: `Rate-${bps}`,
				address: 'ул. Future',
				city: 'Sochi',
				tourismTaxRateBps: bps,
			})
			expect(p.tourismTaxRateBps).toBe(bps)
			expect((await repo.getById(TENANT_A, p.id))?.tourismTaxRateBps).toBe(bps)
		}
	})
})
