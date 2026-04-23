/**
 * Guest repo — YDB integration tests.
 *
 * Business invariants per mandatory pre-test checklist:
 *
 *   Tenant isolation (every method):
 *     [GT1] getById cross-tenant → null, own-tenant row intact
 *     [GT2] list cross-tenant with pre-seeded noise → []
 *     [GT3] update cross-tenant → null, row+payload unchanged
 *     [GT4] delete cross-tenant → false, row still present
 *
 *   Lifecycle + immutables:
 *     [GL1] create → getById reads back equal object (deep equal)
 *     [GL2] update preserves id, tenantId, createdAt (immutable per repo docs)
 *     [GL3] update advances updatedAt strictly > createdAt (monotonic)
 *     [GL4] delete returns true once, false on the second attempt (idempotent-refuse)
 *     [GL5] update on a non-existent guest → null
 *
 *   Null-patch vs undefined-patch (per checklist):
 *     [GP1] undefined in patch = keep current value (field NOT cleared)
 *     [GP2] null in patch on nullable field = explicit clear
 *     [GP3] update without any field → Zod-rejected at route layer
 *           (repo accepts raw input; invariant documented, no repo test)
 *
 *   RU compliance field roundtrip:
 *     [GR1] Foreign-guest visa + migration card fields roundtrip as YYYY-MM-DD
 *     [GR2] Russian citizen (RU) with only documentType/Number — other
 *           foreign-specific columns stay null
 *     [GR3] registrationAddress (free-form Utf8) accepts stringified JSON
 *
 *   List ordering:
 *     [GO1] list returns guests ordered by lastName ASC, firstName ASC
 *
 * Requires local YDB.
 */
import type { GuestCreateInput } from '@horeca/shared'
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createGuestRepo } from './guest.repo.ts'

const TENANT_A = newId('organization')
const TENANT_B = newId('organization')

function buildInput(over: Partial<GuestCreateInput> = {}): GuestCreateInput {
	return {
		lastName: 'Петров',
		firstName: 'Иван',
		citizenship: 'RU',
		documentType: 'ruPassport',
		documentNumber: '4510 123456',
		...over,
	}
}

describe('guest.repo', { tags: ['db'], timeout: 30_000 }, () => {
	let repo: ReturnType<typeof createGuestRepo>
	const createdIds: Array<{ tenantId: string; id: string }> = []

	beforeAll(async () => {
		await setupTestDb()
		repo = createGuestRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const k of createdIds) {
			await sql`DELETE FROM guest WHERE tenantId = ${k.tenantId} AND id = ${k.id}`
		}
		await teardownTestDb()
	})

	const track = (g: { tenantId: string; id: string }) => createdIds.push(g)

	// ---------------- Tenant isolation ----------------

	test('[GT1] getById cross-tenant → null, own-tenant intact', async () => {
		const g = await repo.create(TENANT_A, buildInput())
		track(g)
		expect(await repo.getById(TENANT_B, g.id)).toBeNull()
		expect((await repo.getById(TENANT_A, g.id))?.lastName).toBe('Петров')
	})

	test('[GT2] list cross-tenant with pre-seeded noise → []', async () => {
		const g = await repo.create(TENANT_A, buildInput({ lastName: 'Noise' }))
		track(g)
		const cross = await repo.list(TENANT_B)
		// `list` returns ALL tenant B guests; filter-noise check = no overlap.
		expect(cross.every((x) => x.tenantId === TENANT_B)).toBe(true)
		expect(cross.some((x) => x.id === g.id)).toBe(false)
	})

	test('[GT3] update cross-tenant → null, row untouched', async () => {
		const g = await repo.create(TENANT_A, buildInput({ notes: 'original' }))
		track(g)
		expect(await repo.update(TENANT_B, g.id, { notes: 'hacked' })).toBeNull()
		const after = await repo.getById(TENANT_A, g.id)
		expect(after?.notes).toBe('original')
	})

	test('[GT4] delete cross-tenant → false, row still present', async () => {
		const g = await repo.create(TENANT_A, buildInput())
		track(g)
		expect(await repo.delete(TENANT_B, g.id)).toBe(false)
		expect(await repo.getById(TENANT_A, g.id)).not.toBeNull()
	})

	// ---------------- Lifecycle ----------------

	test('[GL1] create → getById deep equal', async () => {
		const input = buildInput({
			middleName: 'Сергеевич',
			birthDate: '1985-03-12',
			phone: '+79998887766',
			email: 'ivan@example.ru',
		})
		const created = await repo.create(TENANT_A, input)
		track(created)
		const fetched = await repo.getById(TENANT_A, created.id)
		expect(fetched).toEqual(created)
	})

	test('[GL2,GL3] update preserves immutables + monotonic updatedAt', async () => {
		const g = await repo.create(TENANT_A, buildInput())
		track(g)
		await new Promise((r) => setTimeout(r, 12))
		const updated = await repo.update(TENANT_A, g.id, { phone: '+79999999999' })
		expect(updated).not.toBeNull()
		if (!updated) return
		expect(updated.id).toBe(g.id)
		expect(updated.tenantId).toBe(g.tenantId)
		expect(updated.createdAt).toBe(g.createdAt)
		expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(g.updatedAt).getTime())
	})

	test('[GL4] delete returns true once, false on second attempt', async () => {
		const g = await repo.create(TENANT_A, buildInput())
		// NOTE: not tracking — this row is being deleted inside the test.
		expect(await repo.delete(TENANT_A, g.id)).toBe(true)
		expect(await repo.delete(TENANT_A, g.id)).toBe(false)
	})

	test('[GL5] update on non-existent guest → null', async () => {
		const bogus = newId('guest')
		expect(await repo.update(TENANT_A, bogus, { lastName: 'X' })).toBeNull()
	})

	// ---------------- Patch semantics ----------------

	test('[GP1] undefined in patch keeps current value', async () => {
		const g = await repo.create(TENANT_A, buildInput({ phone: '+79998887766' }))
		track(g)
		// `phone` not in the patch → must be preserved.
		const updated = await repo.update(TENANT_A, g.id, { email: 'new@ex.ru' })
		expect(updated?.phone).toBe('+79998887766')
		expect(updated?.email).toBe('new@ex.ru')
	})

	test('[GP2] null in patch clears nullable field', async () => {
		const g = await repo.create(TENANT_A, buildInput({ phone: '+79998887766' }))
		track(g)
		const updated = await repo.update(TENANT_A, g.id, { phone: null })
		expect(updated?.phone).toBeNull()
	})

	// ---------------- RU compliance fields ----------------

	test('[GR1] foreign-guest visa + migration card YYYY-MM-DD roundtrip', async () => {
		const foreign = buildInput({
			lastName: 'Smith',
			firstName: 'John',
			citizenship: 'US',
			documentType: 'foreignPassport',
			documentNumber: 'AB1234567',
			visaNumber: 'V-00012345',
			visaType: 'Tourist',
			visaExpiresAt: '2026-12-31',
			migrationCardNumber: 'MC-9876543',
			arrivalDate: '2026-07-15',
			stayUntil: '2026-08-15',
		})
		const g = await repo.create(TENANT_A, foreign)
		track(g)
		const fetched = await repo.getById(TENANT_A, g.id)
		expect(fetched?.citizenship).toBe('US')
		expect(fetched?.visaNumber).toBe('V-00012345')
		expect(fetched?.visaExpiresAt).toBe('2026-12-31')
		expect(fetched?.migrationCardNumber).toBe('MC-9876543')
		expect(fetched?.arrivalDate).toBe('2026-07-15')
		expect(fetched?.stayUntil).toBe('2026-08-15')
	})

	test('[GR2] RU citizen with minimal input → foreign-specific columns null', async () => {
		const g = await repo.create(TENANT_A, buildInput())
		track(g)
		expect(g.visaNumber).toBeNull()
		expect(g.visaType).toBeNull()
		expect(g.visaExpiresAt).toBeNull()
		expect(g.migrationCardNumber).toBeNull()
		expect(g.arrivalDate).toBeNull()
		expect(g.stayUntil).toBeNull()
	})

	test('[GR3] registrationAddress accepts stringified JSON structure', async () => {
		const addressJson = JSON.stringify({
			country: 'RU',
			region: 'Краснодарский край',
			city: 'Сочи',
			street: 'ул. Орджоникидзе',
			building: '15',
			flat: '42',
		})
		const g = await repo.create(TENANT_A, buildInput({ registrationAddress: addressJson }))
		track(g)
		const fetched = await repo.getById(TENANT_A, g.id)
		expect(fetched?.registrationAddress).toBe(addressJson)
		// Roundtrip parseable.
		expect(JSON.parse(fetched?.registrationAddress ?? 'null')).toEqual({
			country: 'RU',
			region: 'Краснодарский край',
			city: 'Сочи',
			street: 'ул. Орджоникидзе',
			building: '15',
			flat: '42',
		})
	})

	// ---------------- Ordering ----------------

	test('[GO1] list ordered by lastName ASC, firstName ASC', async () => {
		// Insert in reverse to rule out coincidental order.
		const orderTenant = newId('organization')
		const alpha = await repo.create(
			orderTenant,
			buildInput({ lastName: 'Zebrovich', firstName: 'Anna' }),
		)
		track(alpha)
		const beta = await repo.create(
			orderTenant,
			buildInput({ lastName: 'Abramov', firstName: 'Zoe' }),
		)
		track(beta)
		const gamma = await repo.create(
			orderTenant,
			buildInput({ lastName: 'Abramov', firstName: 'Alex' }),
		)
		track(gamma)
		const listed = await repo.list(orderTenant)
		expect(listed.map((g) => `${g.lastName}/${g.firstName}`)).toEqual([
			'Abramov/Alex',
			'Abramov/Zoe',
			'Zebrovich/Anna',
		])
	})
})
