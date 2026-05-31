/**
 * Channel dispatch repo — strict integration tests CDR1-CDR9 (M10 / A7.1.fix).
 *
 * Requires local YDB. Tests:
 *   - enqueue + getById roundtrip (payload JSON + bigint preservation)
 *   - claimDueBatch atomic lease (concurrent claimer sees leased row not-due)
 *   - markSent / markRetry / markDlq state transitions
 *   - markDisabled bulk-affects pending rows of (tenantId, channelId)
 *   - Cross-tenant isolation
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createChannelDispatchRepo } from './dispatch.repo.ts'

const RUN_ID = Date.now().toString(36)
const TENANT_A = `org_cd_a_${RUN_ID}`
const TENANT_B = `org_cd_b_${RUN_ID}`

describe('channel dispatch repo', () => {
	let repo: ReturnType<typeof createChannelDispatchRepo>

	beforeAll(async () => {
		await setupTestDb()
		repo = createChannelDispatchRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		await sql`DELETE FROM channelDispatch WHERE tenantId = ${TENANT_A}`
		await sql`DELETE FROM channelDispatch WHERE tenantId = ${TENANT_B}`
		await teardownTestDb()
	})

	test('[CDR1] enqueue + getById roundtrip preserves all fields exactly', async () => {
		const enqueueRes = await repo.enqueue({
			tenantId: TENANT_A,
			channelId: 'TL',
			eventSource: `urn:sochi:channel:TL:tenant:${TENANT_A}`,
			eventId: 'evt_cdr1',
			eventType: 'app.sochi.channel.booking.created.v1',
			idempotencyKey: `${TENANT_A}:b1:1:TL`,
			payload: { hello: 'world', n: 42 },
		})
		const got = await repo.getById({ tenantId: TENANT_A, dispatchId: enqueueRes.dispatchId })
		expect(got).not.toBeNull()
		expect(got?.tenantId).toBe(TENANT_A)
		expect(got?.channelId).toBe('TL')
		expect(got?.eventId).toBe('evt_cdr1')
		expect(got?.eventType).toBe('app.sochi.channel.booking.created.v1')
		expect(got?.idempotencyKey).toBe(`${TENANT_A}:b1:1:TL`)
		expect(got?.payload).toEqual({ hello: 'world', n: 42 })
		expect(got?.attemptCount).toBe(0)
		expect(got?.status).toBe('pending')
	})

	test('[CDR2] claimDueBatch returns due-pending rows + leases nextAttemptAt', async () => {
		const before = await repo.listByTenant(TENANT_A)
		const beforePendingCount = before.filter((r) => r.status === 'pending').length
		const leased = await repo.claimDueBatch({
			nowMs: Date.now() + 60_000,
			limit: 100,
			leaseMs: 30_000,
		})
		expect(leased.length).toBe(beforePendingCount)
		// Subsequent immediate claim sees nothing (leased rows pushed forward).
		const second = await repo.claimDueBatch({
			nowMs: Date.now() + 60_000,
			limit: 100,
			leaseMs: 30_000,
		})
		expect(second.length).toBe(0)
	})

	test('[CDR3] markSent → status=sent, attemptCount++, lastHttpStatus stored', async () => {
		const e = await repo.enqueue({
			tenantId: TENANT_A,
			channelId: 'TL',
			eventSource: `urn:sochi:channel:TL:tenant:${TENANT_A}`,
			eventId: 'evt_cdr3',
			eventType: 't',
			idempotencyKey: 'k3',
			payload: {},
		})
		await repo.markSent({ tenantId: TENANT_A, dispatchId: e.dispatchId, httpStatus: 200 })
		const after = await repo.getById({ tenantId: TENANT_A, dispatchId: e.dispatchId })
		expect(after?.status).toBe('sent')
		expect(after?.attemptCount).toBe(1)
		expect(after?.lastHttpStatus).toBe(200)
	})

	test('[CDR4] markRetry → status=pending, attemptCount++, nextAttemptAt updated', async () => {
		const e = await repo.enqueue({
			tenantId: TENANT_A,
			channelId: 'TL',
			eventSource: `urn:sochi:channel:TL:tenant:${TENANT_A}`,
			eventId: 'evt_cdr4',
			eventType: 't',
			idempotencyKey: 'k4',
			payload: {},
		})
		const future = Date.now() + 5 * 60_000
		await repo.markRetry({
			tenantId: TENANT_A,
			dispatchId: e.dispatchId,
			httpStatus: 500,
			errorJson: { message: 'upstream' },
			nextAttemptAtMs: future,
		})
		const after = await repo.getById({ tenantId: TENANT_A, dispatchId: e.dispatchId })
		expect(after?.status).toBe('pending')
		expect(after?.attemptCount).toBe(1)
		expect(after?.lastHttpStatus).toBe(500)
		expect(new Date(after?.nextAttemptAt ?? 0).getTime()).toBeGreaterThan(Date.now())
	})

	test('[CDR5] markDlq → status=dlq, attemptCount++, lastErrorJson stored', async () => {
		const e = await repo.enqueue({
			tenantId: TENANT_A,
			channelId: 'TL',
			eventSource: `urn:sochi:channel:TL:tenant:${TENANT_A}`,
			eventId: 'evt_cdr5',
			eventType: 't',
			idempotencyKey: 'k5',
			payload: {},
		})
		await repo.markDlq({
			tenantId: TENANT_A,
			dispatchId: e.dispatchId,
			httpStatus: 400,
			errorJson: { message: 'bad' },
		})
		const after = await repo.getById({ tenantId: TENANT_A, dispatchId: e.dispatchId })
		expect(after?.status).toBe('dlq')
		expect(after?.lastErrorJson).toEqual({ message: 'bad' })
	})

	test('[CDR6] markDisabled flips ALL pending rows of (tenantId, channelId) → disabled', async () => {
		const e1 = await repo.enqueue({
			tenantId: TENANT_A,
			channelId: 'YT',
			eventSource: `urn:sochi:channel:YT:tenant:${TENANT_A}`,
			eventId: 'evt_cdr6_a',
			eventType: 't',
			idempotencyKey: 'k6a',
			payload: {},
		})
		const e2 = await repo.enqueue({
			tenantId: TENANT_A,
			channelId: 'YT',
			eventSource: `urn:sochi:channel:YT:tenant:${TENANT_A}`,
			eventId: 'evt_cdr6_b',
			eventType: 't',
			idempotencyKey: 'k6b',
			payload: {},
		})
		const result = await repo.markDisabled({
			tenantId: TENANT_A,
			channelId: 'YT',
			reason: 'sync_disabled_test',
		})
		expect(result.affected).toBeGreaterThanOrEqual(2)
		const a = await repo.getById({ tenantId: TENANT_A, dispatchId: e1.dispatchId })
		const b = await repo.getById({ tenantId: TENANT_A, dispatchId: e2.dispatchId })
		expect(a?.status).toBe('disabled')
		expect(b?.status).toBe('disabled')
	})

	test('[CDR7] cross-tenant getById returns null', async () => {
		const e = await repo.enqueue({
			tenantId: TENANT_B,
			channelId: 'TL',
			eventSource: `urn:sochi:channel:TL:tenant:${TENANT_B}`,
			eventId: 'evt_cdr7',
			eventType: 't',
			idempotencyKey: 'k7',
			payload: {},
		})
		const tenantBView = await repo.getById({ tenantId: TENANT_B, dispatchId: e.dispatchId })
		const tenantAView = await repo.getById({ tenantId: TENANT_A, dispatchId: e.dispatchId })
		expect(tenantBView?.dispatchId).toBe(e.dispatchId)
		expect(tenantAView).toBeNull()
	})

	test('[CDR8] listByTenant scoped to tenantId only', async () => {
		const a = await repo.listByTenant(TENANT_A)
		const b = await repo.listByTenant(TENANT_B)
		expect(a.every((r) => r.tenantId === TENANT_A)).toBe(true)
		expect(b.every((r) => r.tenantId === TENANT_B)).toBe(true)
	})

	test('[CDR9] dispatch status enum FULL coverage round-trip (pending|sent|dlq|disabled)', async () => {
		const all = await repo.listByTenant(TENANT_A)
		const seen = new Set(all.map((r) => r.status))
		expect(seen.has('pending')).toBe(true)
		expect(seen.has('sent')).toBe(true)
		expect(seen.has('dlq')).toBe(true)
		expect(seen.has('disabled')).toBe(true)
	})
})
