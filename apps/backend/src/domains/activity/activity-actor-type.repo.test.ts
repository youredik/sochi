/**
 * Activity actorType column — integration tests for M8.A.0.fix.2.
 *
 * Strict per `feedback_strict_tests.md`:
 *   - exact-value asserts on every enum value (full coverage)
 *   - default value is `'user'` when caller omits actorType (M7 semantics)
 *   - explicit `'system'` / `'guest'` / `'channel'` roundtrip
 *   - cross-tenant isolation
 *   - column type: rejects unknown enum at app boundary
 */
import { type ActivityActorType, activityActorTypeSchema } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createActivityRepo } from './activity.repo.ts'

const RUN_ID = Date.now().toString(36)
const TENANT_A = `org_act_at_a_${RUN_ID}`
const TENANT_B = `org_act_at_b_${RUN_ID}`

describe('activity.actorType column', { tags: ['db'], timeout: 30_000 }, () => {
	let repo: ReturnType<typeof createActivityRepo>

	beforeAll(async () => {
		await setupTestDb()
		repo = createActivityRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const t of [TENANT_A, TENANT_B]) {
			// eslint-disable-next-line drop -- raw cleanup sweep (TTL would also handle, but immediate)
			await sql`DELETE FROM activity WHERE tenantId = ${t}`
		}
		await teardownTestDb()
	})

	test('[A1] insert without actorType → defaults to user (M7 backwards compat)', async () => {
		const out = await repo.insert({
			tenantId: TENANT_A,
			objectType: 'booking',
			recordId: `book_default_${RUN_ID}`,
			activityType: 'created',
			actorUserId: 'usr_test',
			diffJson: { fields: { x: 1 } },
		})
		expect(out.actorType).toBe('user')
	})

	test('[A2] every enum value roundtrips exactly through column', async () => {
		const all: ActivityActorType[] = ['user', 'guest', 'system', 'channel']
		for (const at of all) {
			const out = await repo.insert({
				tenantId: TENANT_A,
				objectType: 'booking',
				recordId: `book_${at}_${RUN_ID}`,
				activityType: 'fieldChange',
				actorUserId: at === 'system' ? 'system:test' : 'usr_test',
				actorType: at,
				diffJson: { field: 'x', oldValue: 1, newValue: 2 },
			})
			expect(out.actorType).toBe(at)
			// Round-trip via list
			const list = await repo.listForRecord(TENANT_A, 'booking', `book_${at}_${RUN_ID}`, 10)
			expect(list[0]?.actorType).toBe(at)
		}
	})

	test('[A3] cross-tenant: TENANT_A actorType row not visible in TENANT_B', async () => {
		const recordId = `book_ct_${RUN_ID}`
		await repo.insert({
			tenantId: TENANT_A,
			objectType: 'booking',
			recordId,
			activityType: 'created',
			actorUserId: 'usr_test',
			actorType: 'guest',
			diffJson: { fields: {} },
		})
		const a = await repo.listForRecord(TENANT_A, 'booking', recordId, 10)
		const b = await repo.listForRecord(TENANT_B, 'booking', recordId, 10)
		expect(a.length).toBeGreaterThan(0)
		expect(a[0]?.actorType).toBe('guest')
		expect(b).toEqual([])
	})

	test('[A_MR] manualRetry path: operator-triggered → defaults to user (notification.service canon)', async () => {
		// Mirrors `notification.service.markForRetry` call — operator pulls
		// the retry button. No explicit actorType passed; repo default = 'user'.
		const recordId = `ntf_mr_${RUN_ID}`
		const out = await repo.insert({
			tenantId: TENANT_A,
			objectType: 'notification',
			recordId,
			activityType: 'manualRetry',
			actorUserId: 'usr_admin',
			diffJson: { action: 'manual_retry', retryCount_before: null, nextStatus: 'pending' },
		})
		expect(out.actorType).toBe('user')
		expect(out.activityType).toBe('manualRetry')
		// Roundtrip via list — no drift on read
		const list = await repo.listForRecord(TENANT_A, 'notification', recordId, 10)
		expect(list[0]?.actorType).toBe('user')
	})

	test('[A4] schema enum (Zod) — every value accepted, off-enum rejected', () => {
		expect(activityActorTypeSchema.parse('user')).toBe('user')
		expect(activityActorTypeSchema.parse('guest')).toBe('guest')
		expect(activityActorTypeSchema.parse('system')).toBe('system')
		expect(activityActorTypeSchema.parse('channel')).toBe('channel')
		expect(() => activityActorTypeSchema.parse('admin')).toThrow()
		expect(() => activityActorTypeSchema.parse('USER')).toThrow() // case-sensitive
		expect(() => activityActorTypeSchema.parse('')).toThrow()
		expect(() => activityActorTypeSchema.parse(null)).toThrow()
	})
})
