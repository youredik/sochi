/**
 * Notification admin-console — FULL integration tests against real YDB.
 *
 * Pre-done audit checklist (memory `feedback_pre_done_audit.md`):
 *
 *   list:
 *     [L1]  empty tenant → { items: [], nextCursor: null }
 *     [L2]  single row → exact-value KPI / shape
 *     [L3]  ordering: createdAt DESC, id DESC (newest first)
 *     [L4]  filter status=failed
 *     [L5]  filter kind=payment_succeeded
 *     [L6]  filter recipient (exact match)
 *     [L7]  filter from / to date range (inclusive)
 *     [L8]  cursor pagination — page 1 + page 2 round-trip exact
 *     [L9]  invalid cursor → silently treated as no cursor (defensive)
 *     [L10] cross-tenant: TENANT_B never sees TENANT_A's rows
 *     [L11] limit boundary — exactly limit rows → nextCursor=null (no over-page)
 *
 *   getById:
 *     [G1] present row → fully hydrated Notification
 *     [G2] absent id → null
 *     [G3] cross-tenant: tenantId mismatch → null
 *
 *   markForRetry:
 *     [R1] failed row → status=pending, retryCount=0, failureReason=null
 *     [R2] pending row → also OK (idempotent — operator can force re-dispatch)
 *     [R3] sent row → throws NotificationAlreadySentError
 *     [R4] absent id → throws NotificationNotFoundError
 *     [R5] cross-tenant: TENANT_B retry of TENANT_A row → NotFoundError
 *     [R6] activity-log row created with objectType='notification' +
 *          activityType='manualRetry' + correct actor
 *     [R7] sequential retries on same id → idempotent (no extra fields drift)
 *
 *   getDetail composition:
 *     [D1] sent row → 1 attempt of kind 'sent'
 *     [D2] failed row → 1 attempt of kind 'permanent_failure' with reason
 *     [D3] pending row with prior failure → 1 attempt 'transient_failure'
 *     [D4] fresh pending row (no failure yet) → empty attempts array
 *     [D5] absent id → null
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
	NULL_TEXT,
	NULL_TIMESTAMP,
	textOpt,
	timestampOpt,
	toJson,
	toTs,
} from '../../db/ydb-helpers.ts'
import { NotificationAlreadySentError, NotificationNotFoundError } from '../../errors/domain.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createActivityFactory } from '../activity/activity.factory.ts'
import { createNotificationFactory } from './notification.factory.ts'

const TENANT_A = newId('organization')
const TENANT_B = newId('organization')
const ACTOR = newId('user')

interface SeedOpts {
	tenantId: string
	id?: string
	kind?: string
	recipient?: string
	subject?: string
	status?: 'pending' | 'sent' | 'failed'
	retryCount?: number
	nextAttemptAt?: Date | null
	failureReason?: string | null
	sentAt?: Date | null
	failedAt?: Date | null
	createdAt?: Date
	sourceObjectType?: string
	sourceObjectId?: string
}

async function seed(opts: SeedOpts): Promise<string> {
	const sql = getTestSql()
	const id = opts.id ?? newId('notification')
	const now = opts.createdAt ?? new Date()
	const nowTs = toTs(now)
	const status = opts.status ?? 'pending'
	const sourceObjectType = opts.sourceObjectType ?? 'payment'
	const sourceObjectId = opts.sourceObjectId ?? newId('payment')
	const dedupKey = `${sourceObjectType}:${sourceObjectId}:${opts.kind ?? 'payment_succeeded'}`

	await sql`
		UPSERT INTO notificationOutbox (
			\`tenantId\`, \`id\`, \`kind\`, \`channel\`, \`recipient\`, \`subject\`,
			\`bodyText\`, \`payloadJson\`, \`status\`, \`sentAt\`, \`failedAt\`,
			\`failureReason\`, \`retryCount\`, \`sourceObjectType\`, \`sourceObjectId\`,
			\`sourceEventDedupKey\`, \`nextAttemptAt\`, \`messageId\`,
			\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
		) VALUES (
			${opts.tenantId}, ${id}, ${opts.kind ?? 'payment_succeeded'}, ${'email'},
			${opts.recipient ?? 'guest@example.local'}, ${opts.subject ?? 'Subject'},
			${'Body'}, ${toJson({ test: true })}, ${status},
			${timestampOpt(opts.sentAt ?? null)}, ${timestampOpt(opts.failedAt ?? null)},
			${textOpt(opts.failureReason ?? null)}, ${opts.retryCount ?? 0},
			${sourceObjectType}, ${sourceObjectId}, ${dedupKey},
			${timestampOpt(opts.nextAttemptAt ?? null)}, ${NULL_TEXT},
			${nowTs}, ${nowTs}, ${'system'}, ${'system'}
		)
	`
	return id
}

async function cleanupTenant(tenantId: string) {
	const sql = getTestSql()
	await sql`DELETE FROM notificationOutbox WHERE tenantId = ${tenantId}`
	await sql`DELETE FROM activity WHERE tenantId = ${tenantId}`
}

describe('notification.repo + service integration', { tags: ['db'], timeout: 60_000 }, () => {
	let factory: ReturnType<typeof createNotificationFactory>
	let activityRepo: ReturnType<typeof createActivityFactory>['repo']

	beforeAll(async () => {
		await setupTestDb()
		const sql = getTestSql()
		const activityFactory = createActivityFactory(sql)
		activityRepo = activityFactory.repo
		factory = createNotificationFactory(sql, activityRepo)
	})

	afterAll(async () => {
		await cleanupTenant(TENANT_A)
		await cleanupTenant(TENANT_B)
		await teardownTestDb()
	})

	// ---------------- list ----------------

	test('[L1] empty tenant → empty page + nextCursor null', async () => {
		const emptyTenant = newId('organization')
		const page = await factory.service.list(emptyTenant, { limit: 50 })
		expect(page.items).toEqual([])
		expect(page.nextCursor).toBeNull()
	})

	test('[L2] single seeded row → exact shape', async () => {
		const tenantId = newId('organization')
		await seed({ tenantId, kind: 'payment_succeeded', recipient: 'a@b.local' })
		const page = await factory.service.list(tenantId, { limit: 50 })
		expect(page.items).toHaveLength(1)
		const item = page.items[0]
		expect(item?.kind).toBe('payment_succeeded')
		expect(item?.recipient).toBe('a@b.local')
		expect(item?.status).toBe('pending')
		expect(item?.retryCount).toBe(0)
		expect(page.nextCursor).toBeNull()
		await cleanupTenant(tenantId)
	})

	test('[L3] ordering — createdAt DESC, newest first', async () => {
		const tenantId = newId('organization')
		const oldId = await seed({
			tenantId,
			createdAt: new Date('2026-01-01T00:00:00Z'),
		})
		const midId = await seed({
			tenantId,
			createdAt: new Date('2026-02-01T00:00:00Z'),
		})
		const newId_ = await seed({
			tenantId,
			createdAt: new Date('2026-03-01T00:00:00Z'),
		})
		const page = await factory.service.list(tenantId, { limit: 50 })
		expect(page.items.map((i) => i.id)).toEqual([newId_, midId, oldId])
		await cleanupTenant(tenantId)
	})

	test('[L4] filter status=failed — only failed rows', async () => {
		const tenantId = newId('organization')
		await seed({ tenantId, status: 'pending' })
		const failedId = await seed({
			tenantId,
			status: 'failed',
			failedAt: new Date(),
			failureReason: 'SMTP 550',
		})
		await seed({ tenantId, status: 'sent', sentAt: new Date() })

		const page = await factory.service.list(tenantId, {
			limit: 50,
			status: 'failed',
		})
		expect(page.items).toHaveLength(1)
		expect(page.items[0]?.id).toBe(failedId)
		await cleanupTenant(tenantId)
	})

	test('[L5] filter kind=booking_confirmed — only matching kind', async () => {
		const tenantId = newId('organization')
		await seed({ tenantId, kind: 'payment_succeeded' })
		const bookingId = await seed({ tenantId, kind: 'booking_confirmed' })

		const page = await factory.service.list(tenantId, {
			limit: 50,
			kind: 'booking_confirmed',
		})
		expect(page.items).toHaveLength(1)
		expect(page.items[0]?.id).toBe(bookingId)
		await cleanupTenant(tenantId)
	})

	test('[L6] filter recipient — exact match', async () => {
		const tenantId = newId('organization')
		await seed({ tenantId, recipient: 'alice@host.local' })
		const bobId = await seed({ tenantId, recipient: 'bob@host.local' })

		const page = await factory.service.list(tenantId, {
			limit: 50,
			recipient: 'bob@host.local',
		})
		expect(page.items).toHaveLength(1)
		expect(page.items[0]?.id).toBe(bobId)
		await cleanupTenant(tenantId)
	})

	test('[L7] filter from/to (inclusive) — date range', async () => {
		const tenantId = newId('organization')
		const beforeId = await seed({
			tenantId,
			createdAt: new Date('2026-01-15T00:00:00Z'),
		})
		const insideId = await seed({
			tenantId,
			createdAt: new Date('2026-02-15T00:00:00Z'),
		})
		const afterId = await seed({
			tenantId,
			createdAt: new Date('2026-03-15T00:00:00Z'),
		})

		const page = await factory.service.list(tenantId, {
			limit: 50,
			from: '2026-02-01',
			to: '2026-02-28',
		})
		expect(page.items.map((i) => i.id)).toEqual([insideId])
		// Sanity — outside ids exist but excluded.
		expect(page.items.find((i) => i.id === beforeId)).toBeUndefined()
		expect(page.items.find((i) => i.id === afterId)).toBeUndefined()
		await cleanupTenant(tenantId)
	})

	test('[L8] cursor pagination — page 1 + page 2 round-trip exact', async () => {
		const tenantId = newId('organization')
		const ids: string[] = []
		// Seed 5 rows with monotonic createdAt for deterministic ordering.
		for (let i = 0; i < 5; i++) {
			const id = await seed({
				tenantId,
				createdAt: new Date(`2026-04-0${i + 1}T00:00:00Z`),
			})
			ids.push(id)
		}
		// Newest first → ids in reverse.
		const expectedOrder = [...ids].reverse()

		const page1 = await factory.service.list(tenantId, { limit: 2 })
		expect(page1.items.map((i) => i.id)).toEqual(expectedOrder.slice(0, 2))
		expect(page1.nextCursor).not.toBeNull()

		const page2 = await factory.service.list(tenantId, {
			limit: 2,
			cursor: page1.nextCursor as string,
		})
		expect(page2.items.map((i) => i.id)).toEqual(expectedOrder.slice(2, 4))
		expect(page2.nextCursor).not.toBeNull()

		const page3 = await factory.service.list(tenantId, {
			limit: 2,
			cursor: page2.nextCursor as string,
		})
		expect(page3.items.map((i) => i.id)).toEqual(expectedOrder.slice(4, 5))
		expect(page3.nextCursor).toBeNull()

		await cleanupTenant(tenantId)
	})

	test('[L9] invalid cursor — silently no-cursor (defensive against URL tampering)', async () => {
		const tenantId = newId('organization')
		await seed({ tenantId })
		const page = await factory.service.list(tenantId, {
			limit: 50,
			cursor: 'GARBAGE_BASE64_~~',
		})
		expect(page.items).toHaveLength(1)
		await cleanupTenant(tenantId)
	})

	test('[L10] cross-tenant — TENANT_B never sees TENANT_A rows', async () => {
		const aId = await seed({ tenantId: TENANT_A, recipient: 'a@a.local' })
		await seed({ tenantId: TENANT_B, recipient: 'b@b.local' })
		const pageB = await factory.service.list(TENANT_B, { limit: 50 })
		expect(pageB.items.find((i) => i.id === aId)).toBeUndefined()
		expect(pageB.items.every((i) => i.tenantId === TENANT_B)).toBe(true)
		await cleanupTenant(TENANT_A)
		await cleanupTenant(TENANT_B)
	})

	test('[L11] limit boundary — exactly limit rows → nextCursor=null', async () => {
		const tenantId = newId('organization')
		for (let i = 0; i < 3; i++) {
			await seed({ tenantId, createdAt: new Date(`2026-04-1${i}T00:00:00Z`) })
		}
		const page = await factory.service.list(tenantId, { limit: 3 })
		expect(page.items).toHaveLength(3)
		expect(page.nextCursor).toBeNull()
		await cleanupTenant(tenantId)
	})

	test('[L12] combined filters AND-semantic — only row matching ALL filters', async () => {
		const tenantId = newId('organization')
		// Seed 5 rows differing on each filter axis, only 1 matches ALL.
		await seed({
			tenantId,
			status: 'pending',
			kind: 'payment_succeeded',
			recipient: 'a@b',
			createdAt: new Date('2026-04-01T00:00:00Z'),
		})
		// Status mismatch.
		await seed({
			tenantId,
			status: 'sent',
			kind: 'booking_confirmed',
			recipient: 'a@b',
			createdAt: new Date('2026-04-01T00:00:00Z'),
			sentAt: new Date(),
		})
		// Kind mismatch.
		await seed({
			tenantId,
			status: 'failed',
			kind: 'payment_succeeded',
			recipient: 'a@b',
			createdAt: new Date('2026-04-01T00:00:00Z'),
			failedAt: new Date(),
		})
		// Recipient mismatch.
		await seed({
			tenantId,
			status: 'failed',
			kind: 'booking_confirmed',
			recipient: 'WRONG@b',
			createdAt: new Date('2026-04-01T00:00:00Z'),
			failedAt: new Date(),
		})
		// Date out-of-range.
		await seed({
			tenantId,
			status: 'failed',
			kind: 'booking_confirmed',
			recipient: 'a@b',
			createdAt: new Date('2026-12-01T00:00:00Z'),
			failedAt: new Date(),
		})
		// THIS one matches ALL 4 filters.
		const matchId = await seed({
			tenantId,
			status: 'failed',
			kind: 'booking_confirmed',
			recipient: 'a@b',
			createdAt: new Date('2026-04-15T00:00:00Z'),
			failedAt: new Date(),
		})

		const page = await factory.service.list(tenantId, {
			limit: 50,
			status: 'failed',
			kind: 'booking_confirmed',
			recipient: 'a@b',
			from: '2026-04-01',
			to: '2026-04-30',
		})
		expect(page.items.map((i) => i.id)).toEqual([matchId])
		await cleanupTenant(tenantId)
	})

	test('[L13] same-day range (from === to) — inclusive', async () => {
		const tenantId = newId('organization')
		const dayId = await seed({
			tenantId,
			createdAt: new Date('2026-04-15T12:00:00Z'),
		})
		// One day before, one day after — must be excluded.
		await seed({ tenantId, createdAt: new Date('2026-04-14T23:59:59Z') })
		await seed({ tenantId, createdAt: new Date('2026-04-16T00:00:01Z') })

		const page = await factory.service.list(tenantId, {
			limit: 50,
			from: '2026-04-15',
			to: '2026-04-15',
		})
		expect(page.items.map((i) => i.id)).toEqual([dayId])
		await cleanupTenant(tenantId)
	})

	test('[L14] cursor malformed: pipe-only "|" → silently no-cursor', async () => {
		const tenantId = newId('organization')
		await seed({ tenantId })
		// base64url('|') = 'fA' — decode → '|', sep at 0, id='', empty id triggers null.
		const page = await factory.service.list(tenantId, {
			limit: 50,
			cursor: Buffer.from('|', 'utf8').toString('base64url'),
		})
		expect(page.items).toHaveLength(1)
		await cleanupTenant(tenantId)
	})

	test('[L15] cursor malformed: missing date "|abc" → silently no-cursor', async () => {
		const tenantId = newId('organization')
		await seed({ tenantId })
		const page = await factory.service.list(tenantId, {
			limit: 50,
			cursor: Buffer.from('|abc', 'utf8').toString('base64url'),
		})
		expect(page.items).toHaveLength(1)
		await cleanupTenant(tenantId)
	})

	test('[L16] cursor malformed: invalid ISO date "not-a-date|abc" → silently no-cursor', async () => {
		const tenantId = newId('organization')
		await seed({ tenantId })
		const page = await factory.service.list(tenantId, {
			limit: 50,
			cursor: Buffer.from('not-a-date|abc', 'utf8').toString('base64url'),
		})
		expect(page.items).toHaveLength(1)
		await cleanupTenant(tenantId)
	})

	test('[L17] cursor malformed: no separator "abc" → silently no-cursor', async () => {
		const tenantId = newId('organization')
		await seed({ tenantId })
		const page = await factory.service.list(tenantId, {
			limit: 50,
			cursor: Buffer.from('abc', 'utf8').toString('base64url'),
		})
		expect(page.items).toHaveLength(1)
		await cleanupTenant(tenantId)
	})

	// ---------------- getById ----------------

	test('[G1] present row → fully hydrated', async () => {
		const tenantId = newId('organization')
		const id = await seed({ tenantId, kind: 'receipt_confirmed' })
		const row = await factory.repo.getById(tenantId, id)
		expect(row?.id).toBe(id)
		expect(row?.kind).toBe('receipt_confirmed')
		expect(row?.tenantId).toBe(tenantId)
		await cleanupTenant(tenantId)
	})

	test('[G2] absent id → null', async () => {
		const row = await factory.repo.getById(TENANT_A, 'ntf_definitelyabsent00')
		expect(row).toBeNull()
	})

	test('[G3] cross-tenant — different tenant returns null even if id exists', async () => {
		const id = await seed({ tenantId: TENANT_A })
		const row = await factory.repo.getById(TENANT_B, id)
		expect(row).toBeNull()
		await cleanupTenant(TENANT_A)
	})

	// ---------------- markForRetry ----------------

	test('[R1] failed row → status=pending, retryCount=0, failureReason=null', async () => {
		const tenantId = newId('organization')
		const id = await seed({
			tenantId,
			status: 'failed',
			failedAt: new Date('2026-04-01T00:00:00Z'),
			failureReason: 'SMTP 550',
			retryCount: 5,
		})
		const updated = await factory.repo.markForRetry(tenantId, id, ACTOR)
		expect(updated.status).toBe('pending')
		expect(updated.retryCount).toBe(0)
		expect(updated.failureReason).toBeNull()
		expect(updated.failedAt).toBeNull()
		expect(updated.sentAt).toBeNull()
		expect(updated.updatedBy).toBe(ACTOR)
		await cleanupTenant(tenantId)
	})

	test('[R2] pending row → also OK (idempotent unblock of stuck row)', async () => {
		const tenantId = newId('organization')
		const id = await seed({
			tenantId,
			status: 'pending',
			retryCount: 2,
			nextAttemptAt: new Date('2099-01-01T00:00:00Z'),
		})
		const updated = await factory.repo.markForRetry(tenantId, id, ACTOR)
		expect(updated.status).toBe('pending')
		expect(updated.retryCount).toBe(0)
		await cleanupTenant(tenantId)
	})

	test('[R3] sent row → throws NotificationAlreadySentError', async () => {
		const tenantId = newId('organization')
		const id = await seed({ tenantId, status: 'sent', sentAt: new Date() })
		await expect(factory.repo.markForRetry(tenantId, id, ACTOR)).rejects.toBeInstanceOf(
			NotificationAlreadySentError,
		)
		await cleanupTenant(tenantId)
	})

	test('[R4] absent id → throws NotificationNotFoundError', async () => {
		await expect(
			factory.repo.markForRetry(TENANT_A, 'ntf_definitelyabsent00', ACTOR),
		).rejects.toBeInstanceOf(NotificationNotFoundError)
	})

	test('[R5] cross-tenant — TENANT_B retry of TENANT_A row → NotFoundError', async () => {
		const id = await seed({ tenantId: TENANT_A, status: 'failed', failedAt: new Date() })
		await expect(factory.repo.markForRetry(TENANT_B, id, ACTOR)).rejects.toBeInstanceOf(
			NotificationNotFoundError,
		)
		await cleanupTenant(TENANT_A)
	})

	test('[R6] service.markForRetry — writes activity-log entry', async () => {
		const tenantId = newId('organization')
		const id = await seed({
			tenantId,
			status: 'failed',
			failedAt: new Date(),
			failureReason: 'SMTP 550',
		})
		await factory.service.markForRetry(tenantId, id, ACTOR)
		const activities = await activityRepo.listForRecord(tenantId, 'notification', id, 50)
		expect(activities).toHaveLength(1)
		expect(activities[0]?.activityType).toBe('manualRetry')
		expect(activities[0]?.actorUserId).toBe(ACTOR)
		await cleanupTenant(tenantId)
	})

	test('[R7] sequential retries — idempotent (no extra fields drift)', async () => {
		const tenantId = newId('organization')
		const id = await seed({
			tenantId,
			status: 'failed',
			failedAt: new Date(),
			failureReason: 'SMTP 550',
		})
		const r1 = await factory.repo.markForRetry(tenantId, id, ACTOR)
		const r2 = await factory.repo.markForRetry(tenantId, id, ACTOR)
		expect(r1.status).toBe(r2.status)
		expect(r1.retryCount).toBe(r2.retryCount)
		expect(r1.failureReason).toBe(r2.failureReason)
		await cleanupTenant(tenantId)
	})

	// ---------------- getDetail composition ----------------

	test('[D1] sent row → 1 attempt of kind sent', async () => {
		const tenantId = newId('organization')
		const sentAt = new Date('2026-04-01T10:00:00Z')
		const id = await seed({ tenantId, status: 'sent', sentAt })
		const detail = await factory.service.getDetail(tenantId, id)
		expect(detail?.attempts).toHaveLength(1)
		expect(detail?.attempts[0]?.kind).toBe('sent')
		expect(detail?.attempts[0]?.reason).toBeNull()
		await cleanupTenant(tenantId)
	})

	test('[D2] failed row → permanent_failure with reason', async () => {
		const tenantId = newId('organization')
		const failedAt = new Date('2026-04-01T11:00:00Z')
		const id = await seed({
			tenantId,
			status: 'failed',
			failedAt,
			failureReason: 'invalid recipient',
		})
		const detail = await factory.service.getDetail(tenantId, id)
		expect(detail?.attempts).toHaveLength(1)
		expect(detail?.attempts[0]?.kind).toBe('permanent_failure')
		expect(detail?.attempts[0]?.reason).toBe('invalid recipient')
		await cleanupTenant(tenantId)
	})

	test('[D3] pending row with prior failure → transient_failure', async () => {
		const tenantId = newId('organization')
		const id = await seed({
			tenantId,
			status: 'pending',
			failureReason: 'connection timeout',
			retryCount: 2,
			nextAttemptAt: new Date('2026-04-01T12:00:00Z'),
		})
		const detail = await factory.service.getDetail(tenantId, id)
		expect(detail?.attempts).toHaveLength(1)
		expect(detail?.attempts[0]?.kind).toBe('transient_failure')
		expect(detail?.attempts[0]?.reason).toBe('connection timeout')
		await cleanupTenant(tenantId)
	})

	test('[D4] fresh pending row (no failure) → empty attempts', async () => {
		const tenantId = newId('organization')
		const id = await seed({ tenantId, status: 'pending' })
		const detail = await factory.service.getDetail(tenantId, id)
		expect(detail?.attempts).toEqual([])
		await cleanupTenant(tenantId)
	})

	test('[D5] absent id → null', async () => {
		const detail = await factory.service.getDetail(TENANT_A, 'ntf_definitelyabsent00')
		expect(detail).toBeNull()
	})
})

// Suppress unused-import lint for NULL_TIMESTAMP — we use timestampOpt instead.
void NULL_TIMESTAMP
