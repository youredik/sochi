/**
 * Channel connection repo — strict integration tests CC1-CC8 (M10 / A7.1.fix).
 *
 * Requires local YDB. Tests:
 *   - Cross-tenant absolute (read + patch)
 *   - PK 3-dim independence (tenantId × propertyId × channelId)
 *   - Three-state patch (undefined=skip, null=clear, value=overwrite)
 *   - Mode + role + syncStatus enum roundtrip
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createChannelConnectionRepo } from './connection.repo.ts'

const RUN_ID = Date.now().toString(36)
const TENANT_A = `org_cc_a_${RUN_ID}`
const TENANT_B = `org_cc_b_${RUN_ID}`
const PROPERTY = 'prop_x'

describe('channel connection repo', { tags: ['db'], timeout: 30_000 }, () => {
	let repo: ReturnType<typeof createChannelConnectionRepo>

	beforeAll(async () => {
		await setupTestDb()
		repo = createChannelConnectionRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		await sql`DELETE FROM channelConnection WHERE tenantId = ${TENANT_A}`
		await sql`DELETE FROM channelConnection WHERE tenantId = ${TENANT_B}`
		await teardownTestDb()
	})

	test('[CC1] create + get roundtrip preserves all fields exactly', async () => {
		await repo.create({
			tenantId: TENANT_A,
			propertyId: PROPERTY,
			channelId: 'TL',
			mode: 'mock',
			role: 'processor_with_dpa',
			isEnabled: true,
		})
		const got = await repo.get({ tenantId: TENANT_A, propertyId: PROPERTY, channelId: 'TL' })
		expect(got).not.toBeNull()
		expect(got?.tenantId).toBe(TENANT_A)
		expect(got?.propertyId).toBe(PROPERTY)
		expect(got?.channelId).toBe('TL')
		expect(got?.mode).toBe('mock')
		expect(got?.role).toBe('processor_with_dpa')
		expect(got?.syncStatus).toBe('idle')
		expect(got?.isEnabled).toBe(true)
		expect(got?.credentialsLockboxRef).toBeNull()
		expect(got?.dpaSignedAt).toBeNull()
		expect(got?.crossBorderNotificationStatus).toBeNull()
	})

	test('[CC2] cross-tenant get returns null (tenant A row not visible to tenant B)', async () => {
		const got = await repo.get({ tenantId: TENANT_B, propertyId: PROPERTY, channelId: 'TL' })
		expect(got).toBeNull()
	})

	test('[CC3] PK separation: same channel different tenant → independent rows', async () => {
		await repo.create({
			tenantId: TENANT_B,
			propertyId: PROPERTY,
			channelId: 'TL',
			mode: 'sandbox',
			role: 'processor_with_dpa',
			isEnabled: false,
		})
		const a = await repo.get({ tenantId: TENANT_A, propertyId: PROPERTY, channelId: 'TL' })
		const b = await repo.get({ tenantId: TENANT_B, propertyId: PROPERTY, channelId: 'TL' })
		expect(a?.mode).toBe('mock')
		expect(b?.mode).toBe('sandbox')
		expect(a?.isEnabled).toBe(true)
		expect(b?.isEnabled).toBe(false)
	})

	test('[CC4] patch undefined keeps existing value', async () => {
		const before = await repo.get({ tenantId: TENANT_A, propertyId: PROPERTY, channelId: 'TL' })
		await repo.patch(
			{ tenantId: TENANT_A, propertyId: PROPERTY, channelId: 'TL' },
			{ syncStatus: 'syncing' },
		)
		const after = await repo.get({ tenantId: TENANT_A, propertyId: PROPERTY, channelId: 'TL' })
		expect(after?.syncStatus).toBe('syncing')
		expect(after?.mode).toBe(before?.mode)
		expect(after?.role).toBe(before?.role)
	})

	test('[CC5] patch null clears nullable column', async () => {
		await repo.patch(
			{ tenantId: TENANT_A, propertyId: PROPERTY, channelId: 'TL' },
			{ credentialsLockboxRef: 'lb_test_ref_1' },
		)
		const set = await repo.get({ tenantId: TENANT_A, propertyId: PROPERTY, channelId: 'TL' })
		expect(set?.credentialsLockboxRef).toBe('lb_test_ref_1')
		await repo.patch(
			{ tenantId: TENANT_A, propertyId: PROPERTY, channelId: 'TL' },
			{ credentialsLockboxRef: null },
		)
		const cleared = await repo.get({ tenantId: TENANT_A, propertyId: PROPERTY, channelId: 'TL' })
		expect(cleared?.credentialsLockboxRef).toBeNull()
	})

	test('[CC6] patch cross-tenant no-op (different tenantId leaves both rows untouched)', async () => {
		await repo.patch(
			{ tenantId: 'org_does_not_exist', propertyId: PROPERTY, channelId: 'TL' },
			{ syncStatus: 'error' },
		)
		const a = await repo.get({ tenantId: TENANT_A, propertyId: PROPERTY, channelId: 'TL' })
		const b = await repo.get({ tenantId: TENANT_B, propertyId: PROPERTY, channelId: 'TL' })
		// Earlier patch set TENANT_A.syncStatus='syncing'.
		expect(a?.syncStatus).toBe('syncing')
		expect(b?.syncStatus).toBe('idle')
	})

	test('[CC7] listByTenant returns ONLY rows для that tenant', async () => {
		const aRows = await repo.listByTenant(TENANT_A)
		const bRows = await repo.listByTenant(TENANT_B)
		expect(aRows.every((r) => r.tenantId === TENANT_A)).toBe(true)
		expect(bRows.every((r) => r.tenantId === TENANT_B)).toBe(true)
		expect(aRows.length).toBeGreaterThanOrEqual(1)
		expect(bRows.length).toBeGreaterThanOrEqual(1)
	})

	test('[CC8] role enum FULL coverage roundtrip', async () => {
		const t = `org_cc_role_${RUN_ID}`
		const sql = getTestSql()
		try {
			await repo.create({
				tenantId: t,
				propertyId: PROPERTY,
				channelId: 'YT',
				mode: 'mock',
				role: 'independent_operator',
				isEnabled: true,
			})
			await repo.create({
				tenantId: t,
				propertyId: PROPERTY,
				channelId: 'ETG',
				mode: 'mock',
				role: 'foreign_recipient',
				isEnabled: true,
			})
			const yt = await repo.get({ tenantId: t, propertyId: PROPERTY, channelId: 'YT' })
			const etg = await repo.get({ tenantId: t, propertyId: PROPERTY, channelId: 'ETG' })
			expect(yt?.role).toBe('independent_operator')
			expect(etg?.role).toBe('foreign_recipient')
		} finally {
			await sql`DELETE FROM channelConnection WHERE tenantId = ${t}`
		}
	})
})
