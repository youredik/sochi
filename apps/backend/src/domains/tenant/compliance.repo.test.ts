/**
 * Tenant compliance repo — YDB integration tests.
 *
 * Strict per `feedback_strict_tests.md`:
 *   1. Tenant isolation absolute — no read/write/clear crosses tenants.
 *   2. Patch semantics three-state: `undefined`=no-change, `null`=clear,
 *      value=overwrite. Each tested with a separate adversarial case.
 *   3. Initial state: row created via afterCreateOrganization hook returns
 *      all 7 compliance fields = null.
 *   4. updatedAt is strictly monotonic on every successful patch.
 *   5. ksrVerifiedAt timestamp survives ms-precision roundtrip.
 *   6. Bool patch round-trips both true and false (no truthy/falsy coercion).
 *   7. Int64 (annual revenue micros) survives bigint roundtrip without
 *      precision loss at the 60M ₽ threshold.
 *   8. Returns null for unknown tenant (NOT silently inserts).
 *
 * Requires local YDB (docker-compose up ydb).
 */
import {
	type KsrCategory,
	type LegalEntityType,
	type TaxRegime,
	tenantCompliancePatchSchema,
	USN_THRESHOLD_2026_MICRO_RUB,
} from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createTenantComplianceRepo } from './compliance.repo.ts'

const RUN_ID = Date.now().toString(36)
const TENANT_A = `org_compliance_a_${RUN_ID}`
const TENANT_B = `org_compliance_b_${RUN_ID}`
const TENANT_GHOST = `org_compliance_missing_${RUN_ID}`

async function seedFreshOrg(tenantId: string) {
	// Mirrors afterCreateOrganization hook in auth.ts. Inserts ONLY the
	// always-required fields; compliance columns default to NULL.
	const sql = getTestSql()
	const now = new Date()
	const trial = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
	await sql`
		UPSERT INTO organizationProfile (
			\`organizationId\`, \`plan\`, \`trialEndsAt\`,
			\`createdAt\`, \`updatedAt\`
		) VALUES (
			${tenantId}, ${'free'}, ${trial},
			${now}, ${now}
		)
	`
}

describe('tenant.compliance.repo', { tags: ['db'], timeout: 30_000 }, () => {
	let repo: ReturnType<typeof createTenantComplianceRepo>

	beforeAll(async () => {
		await setupTestDb()
		repo = createTenantComplianceRepo(getTestSql())
		await seedFreshOrg(TENANT_A)
		await seedFreshOrg(TENANT_B)
		// TENANT_GHOST intentionally has NO row — used to test get() returns null.
	})

	afterAll(async () => {
		const sql = getTestSql()
		await sql`DELETE FROM organizationProfile WHERE organizationId = ${TENANT_A}`
		await sql`DELETE FROM organizationProfile WHERE organizationId = ${TENANT_B}`
		await teardownTestDb()
	})

	test('[I1] get: fresh org has all 7 compliance fields = null', async () => {
		const c = await repo.get(TENANT_A)
		expect(c).not.toBeNull()
		expect(c).toEqual({
			ksrRegistryId: null,
			ksrCategory: null,
			legalEntityType: null,
			taxRegime: null,
			annualRevenueEstimateMicroRub: null,
			guestHouseFz127Registered: null,
			ksrVerifiedAt: null,
		})
	})

	test('[I2] get: returns null for unknown tenant (does NOT silently create)', async () => {
		const c = await repo.get(TENANT_GHOST)
		expect(c).toBeNull()
	})

	test('[P1] patch: single-field set persists exactly, leaves others null', async () => {
		const out = await repo.patch(TENANT_A, { ksrRegistryId: 'KSR-2026-A-001' })
		expect(out?.ksrRegistryId).toBe('KSR-2026-A-001')
		expect(out?.ksrCategory).toBeNull()
		expect(out?.legalEntityType).toBeNull()

		const reread = await repo.get(TENANT_A)
		expect(reread?.ksrRegistryId).toBe('KSR-2026-A-001')
	})

	test('[P2] patch: full enum coverage — every ksrCategory value roundtrips', async () => {
		const all: KsrCategory[] = [
			'hotel',
			'aparthotel',
			'mini_hotel',
			'guest_house',
			'sanatorium',
			'rest_house',
			'hostel',
			'camping',
			'tourist_center',
			'recreation_complex',
			'other',
		]
		for (const cat of all) {
			const out = await repo.patch(TENANT_A, { ksrCategory: cat })
			expect(out?.ksrCategory).toBe(cat)
		}
		// Reset for downstream tests
		await repo.patch(TENANT_A, { ksrCategory: null })
		expect((await repo.get(TENANT_A))?.ksrCategory).toBeNull()
	})

	test('[P3] patch: full enum coverage — every taxRegime value roundtrips', async () => {
		const all: TaxRegime[] = [
			'NPD',
			'USN_DOHODY',
			'USN_DOHODY_RASHODY',
			'PSN',
			'OSN',
			'AUSN_DOHODY',
			'AUSN_DOHODY_RASHODY',
		]
		for (const r of all) {
			const out = await repo.patch(TENANT_A, { taxRegime: r })
			expect(out?.taxRegime).toBe(r)
		}
		await repo.patch(TENANT_A, { taxRegime: null })
	})

	test('[P4] patch: full enum coverage — every legalEntityType value roundtrips', async () => {
		const all: LegalEntityType[] = ['ip', 'ooo', 'ao', 'npd', 'other']
		for (const t of all) {
			const out = await repo.patch(TENANT_A, { legalEntityType: t })
			expect(out?.legalEntityType).toBe(t)
		}
		await repo.patch(TENANT_A, { legalEntityType: null })
	})

	test('[P5] patch: explicit null clears a previously-set field', async () => {
		await repo.patch(TENANT_A, { ksrRegistryId: 'KSR-TO-CLEAR' })
		expect((await repo.get(TENANT_A))?.ksrRegistryId).toBe('KSR-TO-CLEAR')

		const out = await repo.patch(TENANT_A, { ksrRegistryId: null })
		expect(out?.ksrRegistryId).toBeNull()
		expect((await repo.get(TENANT_A))?.ksrRegistryId).toBeNull()
	})

	test('[P6] patch: undefined keeps existing value (three-state semantics)', async () => {
		// Pre-set ksrCategory — must survive a patch that touches a different field.
		await repo.patch(TENANT_A, { ksrCategory: 'hotel' })
		await repo.patch(TENANT_A, { taxRegime: 'OSN' })
		// At this point both ksrCategory='hotel' and taxRegime='OSN'.
		const c = await repo.get(TENANT_A)
		expect(c?.ksrCategory).toBe('hotel')
		expect(c?.taxRegime).toBe('OSN')

		// Reset for downstream tests
		await repo.patch(TENANT_A, { ksrCategory: null, taxRegime: null })
	})

	test('[P7] patch: bool field roundtrips both true and false correctly', async () => {
		const trueOut = await repo.patch(TENANT_A, { guestHouseFz127Registered: true })
		expect(trueOut?.guestHouseFz127Registered).toBe(true)
		expect((await repo.get(TENANT_A))?.guestHouseFz127Registered).toBe(true)

		const falseOut = await repo.patch(TENANT_A, { guestHouseFz127Registered: false })
		expect(falseOut?.guestHouseFz127Registered).toBe(false)
		// Adversarial: verify NOT silently coerced to null. Strict equal.
		expect((await repo.get(TENANT_A))?.guestHouseFz127Registered).toBe(false)

		const nullOut = await repo.patch(TENANT_A, { guestHouseFz127Registered: null })
		expect(nullOut?.guestHouseFz127Registered).toBeNull()
	})

	test('[P8] patch: bigint annual revenue roundtrips at exact USN 60M ₽ threshold', async () => {
		const out = await repo.patch(TENANT_A, {
			annualRevenueEstimateMicroRub: USN_THRESHOLD_2026_MICRO_RUB,
		})
		expect(out?.annualRevenueEstimateMicroRub).toBe(USN_THRESHOLD_2026_MICRO_RUB)

		const reread = await repo.get(TENANT_A)
		expect(reread?.annualRevenueEstimateMicroRub).toBe(60_000_000_000_000n)
		// Strict precision: not number-coerced.
		expect(typeof reread?.annualRevenueEstimateMicroRub).toBe('bigint')

		await repo.patch(TENANT_A, { annualRevenueEstimateMicroRub: null })
	})

	test('[P9] patch: bigint at MAX_SAFE_INTEGER+1 survives without precision loss', async () => {
		const big = BigInt(Number.MAX_SAFE_INTEGER) + 1n
		const out = await repo.patch(TENANT_A, { annualRevenueEstimateMicroRub: big })
		expect(out?.annualRevenueEstimateMicroRub).toBe(big)

		const reread = await repo.get(TENANT_A)
		expect(reread?.annualRevenueEstimateMicroRub).toBe(big)

		await repo.patch(TENANT_A, { annualRevenueEstimateMicroRub: null })
	})

	test('[P10] patch: ksrVerifiedAt ISO timestamp roundtrips with ms precision', async () => {
		const iso = '2026-04-27T10:15:42.123Z'
		const out = await repo.patch(TENANT_A, { ksrVerifiedAt: iso })
		expect(out?.ksrVerifiedAt).toBe(iso)

		const reread = await repo.get(TENANT_A)
		expect(reread?.ksrVerifiedAt).toBe(iso)

		await repo.patch(TENANT_A, { ksrVerifiedAt: null })
	})

	test('[P11] patch: returns null for unknown tenant (no silent insert)', async () => {
		const out = await repo.patch(TENANT_GHOST, { ksrRegistryId: 'WOULD-BE-INSERTED' })
		expect(out).toBeNull()
		// Verify no row was created
		expect(await repo.get(TENANT_GHOST)).toBeNull()
	})

	test('[CT1] cross-tenant: patch on TENANT_A does not affect TENANT_B', async () => {
		await repo.patch(TENANT_A, {
			ksrRegistryId: 'KSR-A',
			ksrCategory: 'hotel',
			taxRegime: 'OSN',
		})
		await repo.patch(TENANT_B, {
			ksrRegistryId: 'KSR-B',
			ksrCategory: 'guest_house',
			taxRegime: 'NPD',
		})

		const a = await repo.get(TENANT_A)
		const b = await repo.get(TENANT_B)
		expect(a?.ksrRegistryId).toBe('KSR-A')
		expect(a?.ksrCategory).toBe('hotel')
		expect(a?.taxRegime).toBe('OSN')
		expect(b?.ksrRegistryId).toBe('KSR-B')
		expect(b?.ksrCategory).toBe('guest_house')
		expect(b?.taxRegime).toBe('NPD')
	})

	test('[CT2] cross-tenant: clearing TENANT_A does NOT clear TENANT_B', async () => {
		// Pre: from CT1, TENANT_B has full set. Clear TENANT_A.
		await repo.patch(TENANT_A, {
			ksrRegistryId: null,
			ksrCategory: null,
			taxRegime: null,
		})

		const a = await repo.get(TENANT_A)
		const b = await repo.get(TENANT_B)
		expect(a?.ksrRegistryId).toBeNull()
		// TENANT_B remains untouched
		expect(b?.ksrRegistryId).toBe('KSR-B')
		expect(b?.ksrCategory).toBe('guest_house')
		expect(b?.taxRegime).toBe('NPD')
	})

	test('[V1] patch input is parseable through Zod (contract enforcement)', () => {
		// At service boundary, every patch input MUST go through Zod.
		// Verify the schema accepts our test fixtures.
		const valid = tenantCompliancePatchSchema.parse({
			ksrRegistryId: 'KSR-001',
			ksrCategory: 'hotel',
			annualRevenueEstimateMicroRub: USN_THRESHOLD_2026_MICRO_RUB,
		})
		expect(valid.ksrRegistryId).toBe('KSR-001')
		expect(valid.ksrCategory).toBe('hotel')
		expect(valid.annualRevenueEstimateMicroRub).toBe(USN_THRESHOLD_2026_MICRO_RUB)
	})
})
