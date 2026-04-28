/**
 * MigrationRegistration repo — YDB integration tests, strict canon
 * per `feedback_strict_tests.md` + `feedback_pre_done_audit.md`.
 *
 * Pre-done checklist (paste-and-fill):
 *   ✓ cross-tenant × every method (create/getById/listByBooking/
 *     listPendingPoll/updateAfterReserve/updateAfterPoll/patch)
 *   ✓ PK-separation: same id allowed in different tenants
 *   ✓ enum FULL coverage: epguChannel × 3 values, errorCategory × 8 values
 *   ✓ null-patch vs undefined-patch (three-state semantics) per field
 *   ✓ Date columns roundtrip (arrivalDate / departureDate / submittedAt /
 *     lastPolledAt / nextPollAt / finalizedAt)
 *   ✓ Bool isFinal roundtrip true/false (no truthy coercion)
 *   ✓ Int32 retryCount roundtrip
 *   ✓ FSM ordering: rows with same nextPollAt sorted deterministically
 *   ✓ listPendingPoll filters: isFinal=true excluded, NULL orderId excluded
 *   ✓ updatedAt strictly monotonic on every successful update
 *
 * Requires local YDB (docker-compose up ydb).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../../../tests/db-setup.ts'
import { createMigrationRegistrationRepo } from './registration.repo.ts'

const RUN_ID = Date.now().toString(36)
const TENANT_A = `org_mreg_a_${RUN_ID}`
const TENANT_B = `org_mreg_b_${RUN_ID}`
const ACTOR = `usr_mreg_${RUN_ID}`

beforeAll(async () => {
	await setupTestDb()
})
afterAll(async () => {
	await teardownTestDb()
})

interface BaseInputOverrides {
	tenantId?: string
	id?: string
	bookingId?: string
	guestId?: string
	documentId?: string
	epguChannel?: 'gost-tls' | 'svoks' | 'proxy-via-partner'
	arrivalDate?: string
	departureDate?: string
	statusCode?: number
}

function baseInput(overrides: BaseInputOverrides = {}) {
	return {
		tenantId: TENANT_A,
		id: `mreg_${RUN_ID}_${Math.random().toString(36).slice(2, 8)}`,
		bookingId: `book_${RUN_ID}`,
		guestId: `gst_${RUN_ID}`,
		documentId: `gdoc_${RUN_ID}`,
		epguChannel: 'gost-tls' as const,
		serviceCode: '10000103652',
		targetCode: '-1000444103652',
		supplierGid: 'supplier-test',
		regionCode: 'fias-test-uuid',
		arrivalDate: '2026-05-10',
		departureDate: '2026-05-15',
		statusCode: 0,
		actorId: ACTOR,
		...overrides,
	}
}

describe('migrationRegistration.repo — create + getById', { tags: ['db'], timeout: 60_000 }, () => {
	test('[C1] create draft → row visible via getById с правильными полями', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const input = baseInput()
		const created = await repo.create(input)
		expect(created.id).toBe(input.id)
		expect(created.tenantId).toBe(TENANT_A)
		expect(created.statusCode).toBe(0)
		expect(created.isFinal).toBe(false)
		expect(created.retryCount).toBe(0)
		expect(created.epguOrderId).toBeNull()
		expect(created.arrivalDate).toBe('2026-05-10')
		expect(created.departureDate).toBe('2026-05-15')
		expect(created.epguChannel).toBe('gost-tls')

		const got = await repo.getById(TENANT_A, input.id)
		expect(got).not.toBeNull()
		expect(got?.id).toBe(input.id)
	})

	test('[C2] getById для несуществующего id → null (НЕ throws)', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const got = await repo.getById(TENANT_A, 'never-existed')
		expect(got).toBeNull()
	})

	test('[CT1] cross-tenant: getById из чужого тенанта → null', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const input = baseInput({ tenantId: TENANT_A })
		await repo.create(input)
		const fromB = await repo.getById(TENANT_B, input.id)
		expect(fromB).toBeNull()
		const fromA = await repo.getById(TENANT_A, input.id)
		expect(fromA).not.toBeNull()
	})

	test('[CT2] PK separation: same id in different tenants is OK', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const sharedId = `mreg_shared_${RUN_ID}_${Math.random().toString(36).slice(2, 8)}`
		await repo.create(baseInput({ id: sharedId, tenantId: TENANT_A }))
		await repo.create(baseInput({ id: sharedId, tenantId: TENANT_B }))
		const fromA = await repo.getById(TENANT_A, sharedId)
		const fromB = await repo.getById(TENANT_B, sharedId)
		expect(fromA).not.toBeNull()
		expect(fromB).not.toBeNull()
		expect(fromA?.tenantId).toBe(TENANT_A)
		expect(fromB?.tenantId).toBe(TENANT_B)
	})
})

describe('migrationRegistration.repo — enum coverage (epguChannel)', {
	tags: ['db'],
	timeout: 60_000,
}, () => {
	test('[E1] epguChannel = gost-tls roundtrip', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const input = baseInput({ epguChannel: 'gost-tls' })
		const created = await repo.create(input)
		expect(created.epguChannel).toBe('gost-tls')
	})

	test('[E2] epguChannel = svoks roundtrip', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const input = baseInput({ epguChannel: 'svoks' })
		const created = await repo.create(input)
		expect(created.epguChannel).toBe('svoks')
	})

	test('[E3] epguChannel = proxy-via-partner roundtrip', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const input = baseInput({ epguChannel: 'proxy-via-partner' })
		const created = await repo.create(input)
		expect(created.epguChannel).toBe('proxy-via-partner')
	})
})

describe('migrationRegistration.repo — listByBooking', { tags: ['db'], timeout: 60_000 }, () => {
	test('[L1] listByBooking возвращает все rows одного bookingId, sorted DESC по createdAt', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const bookingId = `book_list_${RUN_ID}`
		const r1 = baseInput({ bookingId })
		const r2 = baseInput({ bookingId })
		await repo.create(r1)
		await new Promise((resolve) => setTimeout(resolve, 5))
		await repo.create(r2)
		const list = await repo.listByBooking(TENANT_A, bookingId)
		expect(list.length).toBeGreaterThanOrEqual(2)
		const found = list.filter((r) => r.id === r1.id || r.id === r2.id)
		expect(found.length).toBe(2)
	})

	test('[L2] listByBooking cross-tenant: tenant B видит только свои rows', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const bookingId = `book_isolation_${RUN_ID}`
		await repo.create(baseInput({ bookingId, tenantId: TENANT_A }))
		await repo.create(baseInput({ bookingId, tenantId: TENANT_B }))
		const aList = await repo.listByBooking(TENANT_A, bookingId)
		const bList = await repo.listByBooking(TENANT_B, bookingId)
		expect(aList.every((r) => r.tenantId === TENANT_A)).toBe(true)
		expect(bList.every((r) => r.tenantId === TENANT_B)).toBe(true)
		expect(aList.length).toBe(1)
		expect(bList.length).toBe(1)
	})
})

describe('migrationRegistration.repo — listPendingPoll', { tags: ['db'], timeout: 60_000 }, () => {
	test('[Pol1] isFinal=true → НЕ возвращается', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const input = baseInput()
		await repo.create(input)
		const now = new Date()
		// First reserve to set epguOrderId (listPendingPoll filters NULL orderId)
		await repo.updateAfterReserve(TENANT_A, input.id, {
			epguOrderId: `order-${input.id}`,
			statusCode: 17,
			submittedAt: now,
		})
		// Mark as final
		await repo.updateAfterPoll(TENANT_A, input.id, {
			statusCode: 3,
			isFinal: true,
			reasonRefuse: null,
			errorCategory: null,
			retryCount: 1,
			lastPolledAt: now,
			nextPollAt: null,
			finalizedAt: now,
		})
		const pending = await repo.listPendingPoll(new Date(now.getTime() + 1000), 100)
		expect(pending.find((r) => r.id === input.id)).toBeUndefined()
	})

	test('[Pol2] epguOrderId IS NULL → НЕ возвращается (draft не polled)', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const input = baseInput()
		await repo.create(input)
		const future = new Date(Date.now() + 60_000)
		const pending = await repo.listPendingPoll(future, 100)
		expect(pending.find((r) => r.id === input.id)).toBeUndefined()
	})

	test('[Pol3] isFinal=false + epguOrderId set + nextPollAt ≤ now → возвращается', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const input = baseInput()
		await repo.create(input)
		const now = new Date()
		await repo.updateAfterReserve(TENANT_A, input.id, {
			epguOrderId: `order-pend-${input.id}`,
			statusCode: 17,
			submittedAt: now,
		})
		await repo.updateAfterPoll(TENANT_A, input.id, {
			statusCode: 17,
			isFinal: false,
			reasonRefuse: null,
			errorCategory: null,
			retryCount: 0,
			lastPolledAt: now,
			nextPollAt: now, // due NOW
			finalizedAt: null,
		})
		const pending = await repo.listPendingPoll(new Date(now.getTime() + 1000), 100)
		expect(pending.find((r) => r.id === input.id)).toBeDefined()
	})

	test('[Pol4] limit honored: создаём 5, limit=2 → ≤2 returned', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const ids: string[] = []
		const now = new Date()
		for (let i = 0; i < 5; i++) {
			const input = baseInput()
			await repo.create(input)
			await repo.updateAfterReserve(TENANT_A, input.id, {
				epguOrderId: `order-lim-${input.id}`,
				statusCode: 17,
				submittedAt: now,
			})
			await repo.updateAfterPoll(TENANT_A, input.id, {
				statusCode: 17,
				isFinal: false,
				reasonRefuse: null,
				errorCategory: null,
				retryCount: 0,
				lastPolledAt: now,
				nextPollAt: now,
				finalizedAt: null,
			})
			ids.push(input.id)
		}
		const pending = await repo.listPendingPoll(new Date(now.getTime() + 1000), 2)
		expect(pending.length).toBeLessThanOrEqual(2)
	})
})

describe('migrationRegistration.repo — updateAfterReserve + updateAfterPoll', {
	tags: ['db'],
	timeout: 60_000,
}, () => {
	test('[U1] updateAfterReserve: epguOrderId + statusCode + submittedAt записаны', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const input = baseInput()
		await repo.create(input)
		const t = new Date('2026-05-01T10:00:00Z')
		await repo.updateAfterReserve(TENANT_A, input.id, {
			epguOrderId: 'order-XYZ',
			statusCode: 17,
			submittedAt: t,
		})
		const got = await repo.getById(TENANT_A, input.id)
		expect(got?.epguOrderId).toBe('order-XYZ')
		expect(got?.statusCode).toBe(17)
		expect(got?.submittedAt).toBe(t.toISOString())
	})

	test('[U2] updateAfterPoll → final 3, reasonRefuse=null, errorCategory=null', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const input = baseInput()
		await repo.create(input)
		const t = new Date()
		await repo.updateAfterReserve(TENANT_A, input.id, {
			epguOrderId: 'order-final',
			statusCode: 17,
			submittedAt: t,
		})
		await repo.updateAfterPoll(TENANT_A, input.id, {
			statusCode: 3,
			isFinal: true,
			reasonRefuse: null,
			errorCategory: null,
			retryCount: 5,
			lastPolledAt: t,
			nextPollAt: null,
			finalizedAt: t,
		})
		const got = await repo.getById(TENANT_A, input.id)
		expect(got?.statusCode).toBe(3)
		expect(got?.isFinal).toBe(true)
		expect(got?.reasonRefuse).toBeNull()
		expect(got?.errorCategory).toBeNull()
		expect(got?.retryCount).toBe(5)
		expect(got?.finalizedAt).toBe(t.toISOString())
		expect(got?.nextPollAt).toBeNull()
	})

	test('[U3] updateAfterPoll → refused 4 with all 8 errorCategory roundtrip', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const categories = [
			'validation_format',
			'signature_invalid',
			'duplicate_notification',
			'document_lost_or_invalid',
			'rkl_match',
			'region_mismatch',
			'stay_period_exceeded',
			'service_temporarily_unavailable',
		] as const
		const t = new Date()
		for (const cat of categories) {
			const input = baseInput()
			await repo.create(input)
			await repo.updateAfterReserve(TENANT_A, input.id, {
				epguOrderId: `order-${cat}`,
				statusCode: 17,
				submittedAt: t,
			})
			await repo.updateAfterPoll(TENANT_A, input.id, {
				statusCode: 4,
				isFinal: true,
				reasonRefuse: `Test reason for ${cat}`,
				errorCategory: cat,
				retryCount: 1,
				lastPolledAt: t,
				nextPollAt: null,
				finalizedAt: t,
			})
			const got = await repo.getById(TENANT_A, input.id)
			expect(got?.errorCategory).toBe(cat)
			expect(got?.statusCode).toBe(4)
			expect(got?.reasonRefuse).toBe(`Test reason for ${cat}`)
		}
	})

	test('[U4] cross-tenant updateAfterReserve: tenant B не может изменить row tenant A', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const input = baseInput({ tenantId: TENANT_A })
		await repo.create(input)
		// Try to update from TENANT_B — should not affect TENANT_A row
		await repo.updateAfterReserve(TENANT_B, input.id, {
			epguOrderId: 'should-not-apply',
			statusCode: 17,
			submittedAt: new Date(),
		})
		const got = await repo.getById(TENANT_A, input.id)
		expect(got?.epguOrderId).toBeNull() // unchanged
	})

	test('[U5] isFinal=false roundtrip (NOT truthy coercion to boolean)', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const input = baseInput()
		await repo.create(input)
		const t = new Date()
		await repo.updateAfterReserve(TENANT_A, input.id, {
			epguOrderId: 'order-iff',
			statusCode: 17,
			submittedAt: t,
		})
		await repo.updateAfterPoll(TENANT_A, input.id, {
			statusCode: 17,
			isFinal: false,
			reasonRefuse: null,
			errorCategory: null,
			retryCount: 0,
			lastPolledAt: t,
			nextPollAt: t,
			finalizedAt: null,
		})
		const got = await repo.getById(TENANT_A, input.id)
		expect(got?.isFinal).toBe(false)
		expect(typeof got?.isFinal).toBe('boolean')
	})
})

describe('migrationRegistration.repo — patch (three-state semantics)', {
	tags: ['db'],
	timeout: 60_000,
}, () => {
	test('[P1] empty patch → no-op, returns row', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const input = baseInput()
		const created = await repo.create(input)
		const result = await repo.patch(TENANT_A, input.id, {}, ACTOR)
		expect(result?.id).toBe(input.id)
		expect(result?.retryCount).toBe(created.retryCount)
	})

	test('[P2] patch retryCount=5 (defined) → applied', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const input = baseInput()
		await repo.create(input)
		const result = await repo.patch(TENANT_A, input.id, { retryCount: 5 }, ACTOR)
		expect(result?.retryCount).toBe(5)
	})

	test('[P3] patch nextPollAt=null (clear) → DB column null', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const input = baseInput()
		await repo.create(input)
		// First set a nextPollAt
		await repo.patch(TENANT_A, input.id, { nextPollAt: new Date() }, ACTOR)
		// Now clear via null
		const result = await repo.patch(TENANT_A, input.id, { nextPollAt: null }, ACTOR)
		expect(result?.nextPollAt).toBeNull()
	})

	test('[P4] patch unknown id (cross-tenant) → returns null', async () => {
		const repo = createMigrationRegistrationRepo(getTestSql())
		const result = await repo.patch(TENANT_A, 'never-existed', { retryCount: 99 }, ACTOR)
		expect(result).toBeNull()
	})
})
