/**
 * Channel inbox repo — strict integration tests CIR1-CIR6 (M10 / A7.1.fix).
 *
 * Requires local YDB. Tests:
 *   - classifyAndInsert: accepted (first delivery)
 *   - classifyAndInsert: duplicate (same body) → cached record
 *   - classifyAndInsert: tampered (different body, same source+eventId)
 *   - markProcessed persists responseJson
 *   - Cross-tenant: source URN tenant prefix used
 *   - getById + listByTenant scoping
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createInboxRepo } from './inbox.repo.ts'

const RUN_ID = Date.now().toString(36)
const TENANT_A = `org_inbox_a_${RUN_ID}`
const TENANT_B = `org_inbox_b_${RUN_ID}`
const SOURCE_A = `urn:sochi:channel:TL:tenant:${TENANT_A}`
const SOURCE_B = `urn:sochi:channel:TL:tenant:${TENANT_B}`

describe('channel inbox repo', () => {
	let repo: ReturnType<typeof createInboxRepo>

	beforeAll(async () => {
		await setupTestDb()
		repo = createInboxRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		await sql`DELETE FROM channelInbox WHERE tenantId = ${TENANT_A}`
		await sql`DELETE FROM channelInbox WHERE tenantId = ${TENANT_B}`
		await teardownTestDb()
	})

	test('[CIR1] classifyAndInsert: first delivery → accepted', async () => {
		const c = await repo.classifyAndInsert({
			source: SOURCE_A,
			eventId: 'evt_cir1',
			tenantId: TENANT_A,
			channelId: 'TL',
			eventType: 'app.sochi.channel.booking.created.v1',
			bodyHash: 'hash_a_v1',
		})
		expect(c.kind).toBe('accepted')
		if (c.kind === 'accepted') {
			expect(c.record.source).toBe(SOURCE_A)
			expect(c.record.eventId).toBe('evt_cir1')
			expect(c.record.bodyHash).toBe('hash_a_v1')
		}
	})

	test('[CIR2] classifyAndInsert: duplicate (same body) → cached record', async () => {
		const c = await repo.classifyAndInsert({
			source: SOURCE_A,
			eventId: 'evt_cir1',
			tenantId: TENANT_A,
			channelId: 'TL',
			eventType: 'app.sochi.channel.booking.created.v1',
			bodyHash: 'hash_a_v1',
		})
		expect(c.kind).toBe('duplicate')
		if (c.kind === 'duplicate') {
			expect(c.record.source).toBe(SOURCE_A)
			expect(c.record.eventId).toBe('evt_cir1')
		}
	})

	test('[CIR3] classifyAndInsert: tampered (different body) → tampered + ORIGINAL stored unchanged', async () => {
		const c = await repo.classifyAndInsert({
			source: SOURCE_A,
			eventId: 'evt_cir1',
			tenantId: TENANT_A,
			channelId: 'TL',
			eventType: 'app.sochi.channel.booking.created.v1',
			bodyHash: 'hash_a_DIFFERENT',
		})
		expect(c.kind).toBe('tampered')
		// Re-fetch — bodyHash should be ORIGINAL (not overwritten).
		const got = await repo.getById({ source: SOURCE_A, eventId: 'evt_cir1' })
		expect(got?.bodyHash).toBe('hash_a_v1')
	})

	test('[CIR4] markProcessed persists responseJson + status=processed', async () => {
		await repo.markProcessed({
			source: SOURCE_A,
			eventId: 'evt_cir1',
			responseJson: { ok: true, n: 5 },
		})
		const got = await repo.getById({ source: SOURCE_A, eventId: 'evt_cir1' })
		expect(got?.status).toBe('processed')
		expect(got?.responseJson).toEqual({ ok: true, n: 5 })
	})

	test('[CIR5] cross-tenant: same eventId different source URN → independent rows', async () => {
		const cA = await repo.classifyAndInsert({
			source: SOURCE_A,
			eventId: 'evt_cir5_shared',
			tenantId: TENANT_A,
			channelId: 'TL',
			eventType: 't',
			bodyHash: 'h_a',
		})
		const cB = await repo.classifyAndInsert({
			source: SOURCE_B,
			eventId: 'evt_cir5_shared',
			tenantId: TENANT_B,
			channelId: 'TL',
			eventType: 't',
			bodyHash: 'h_b',
		})
		expect(cA.kind).toBe('accepted')
		expect(cB.kind).toBe('accepted')
		const aList = await repo.listByTenant(TENANT_A)
		const bList = await repo.listByTenant(TENANT_B)
		expect(aList.every((r) => r.tenantId === TENANT_A)).toBe(true)
		expect(bList.every((r) => r.tenantId === TENANT_B)).toBe(true)
	})

	test('[CIR6] signatureKid stored on accepted (rotation telemetry)', async () => {
		const c = await repo.classifyAndInsert({
			source: SOURCE_A,
			eventId: 'evt_cir6',
			tenantId: TENANT_A,
			channelId: 'TL',
			eventType: 't',
			bodyHash: 'h_kid',
			signatureKid: 'kid_test_2',
		})
		expect(c.kind).toBe('accepted')
		const got = await repo.getById({ source: SOURCE_A, eventId: 'evt_cir6' })
		expect(got?.signatureKid).toBe('kid_test_2')
	})
})
