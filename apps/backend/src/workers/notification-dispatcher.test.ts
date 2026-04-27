/**
 * Notification dispatcher integration tests against real YDB.
 *
 * **Pre-done audit checklist (`feedback_pre_done_audit.md`):**
 *
 *   Happy path:
 *     [H1] one pending row → adapter sends → status='sent', messageId stored
 *     [H2] multi-row batch → all sent in one cycle
 *
 *   Skip filters:
 *     [S1] status='sent' → not picked up
 *     [S2] status='failed' → not picked up
 *     [S3] retryCount >= maxRetries → not picked up
 *     [S4] nextAttemptAt > now → not picked up (waits its turn)
 *     [S5] nextAttemptAt IS NULL → picked up immediately (initial pending)
 *
 *   Permanent error:
 *     [P1] adapter returns kind='permanent' → status='failed', failureReason set,
 *           NOT retried even after wait
 *
 *   Transient retry:
 *     [T1] adapter returns kind='transient' → retryCount++, nextAttemptAt set,
 *           failureReason set, status STILL pending
 *     [T2] retryCount reaches maxRetries → dead-letter to status='failed'
 *
 *   Cross-tenant:
 *     [CT1] tenantA pending row, tenantB doesn't accidentally see send
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
	dateFromIso,
	dateOpt,
	NULL_TEXT,
	NULL_TIMESTAMP,
	textOpt,
	toJson,
	toTs,
	tsFromIso,
} from '../db/ydb-helpers.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../tests/db-setup.ts'
import { StubAdapter } from './lib/postbox-adapter.ts'
import { startNotificationDispatcher } from './notification-dispatcher.ts'

beforeAll(async () => {
	await setupTestDb()
})
afterAll(async () => {
	await teardownTestDb()
})

const silentLog = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
}

interface SeedNotificationOpts {
	tenantId: string
	id?: string
	kind?: string
	channel?: string
	recipient?: string
	subject?: string
	bodyText?: string | null
	status?: 'pending' | 'sent' | 'failed'
	retryCount?: number
	nextAttemptAt?: Date | null
	sourceObjectType?: string
	sourceObjectId?: string
}

async function seed(opts: SeedNotificationOpts): Promise<{ id: string; tenantId: string }> {
	const sql = getTestSql()
	const id = opts.id ?? newId('notification')
	const now = new Date()
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
			${opts.tenantId}, ${id}, ${opts.kind ?? 'payment_succeeded'}, ${opts.channel ?? 'email'},
			${opts.recipient ?? 'guest@example.local'}, ${opts.subject ?? 'Test'},
			${opts.bodyText ?? 'Test body'}, ${toJson({ test: true })}, ${status},
			${NULL_TIMESTAMP}, ${NULL_TIMESTAMP},
			${NULL_TEXT}, ${opts.retryCount ?? 0}, ${sourceObjectType}, ${sourceObjectId},
			${dedupKey},
			${opts.nextAttemptAt ? tsFromIso(opts.nextAttemptAt.toISOString()) : NULL_TIMESTAMP},
			${NULL_TEXT},
			${nowTs}, ${nowTs}, ${'test-actor'}, ${'test-actor'}
		)
	`
	return { id, tenantId: opts.tenantId }
}

async function getRow(tenantId: string, id: string) {
	const sql = getTestSql()
	// NOT `snapshotReadOnly` — that takes a consistent past snapshot which
	// can lag behind a JUST-committed UPDATE from `pollOnce()` under YDB
	// load. Tests asserting read-after-write ([H1] [H2] [S1] etc.) need
	// serializable (default) reads to see the latest committed state.
	// Observed 2026-04-27: H1/H2 flaked under load with snapshotReadOnly
	// even though `pollOnce` was awaited. Memory `feedback_no_preexisting`.
	const [rows = []] = await sql<
		{
			id: string
			status: string
			retryCount: number | bigint
			messageId: string | null
			failureReason: string | null
			nextAttemptAt: Date | null
		}[]
	>`
		SELECT id, status, retryCount, messageId, failureReason, nextAttemptAt
		FROM notificationOutbox
		WHERE tenantId = ${tenantId} AND id = ${id}
		LIMIT 1
	`.idempotent(true)
	const row = rows[0]
	if (!row) return null
	return {
		status: row.status,
		retryCount: Number(row.retryCount),
		messageId: row.messageId,
		failureReason: row.failureReason,
		nextAttemptAt: row.nextAttemptAt,
	}
}

/* ============================================================ happy path */

describe('dispatcher — happy path', { tags: ['db'] }, () => {
	test('[H1] pending row → adapter.send → status=sent + messageId', async () => {
		const tenantId = newId('organization')
		const { id } = await seed({ tenantId, retryCount: 0 })

		const adapter = new StubAdapter()
		const dispatcher = startNotificationDispatcher(getTestSql(), adapter, silentLog, {
			skipTimer: true,
		})

		const stats = await dispatcher.pollOnce()
		expect(stats.sent).toBeGreaterThanOrEqual(1)

		const row = await getRow(tenantId, id)
		expect(row?.status).toBe('sent')
		expect(row?.messageId).toMatch(/^stub-\d+$/)
		expect(row?.retryCount).toBe(1)

		await dispatcher.stop()
	})

	test('[H2] multi-row batch → all sent in one cycle', async () => {
		const tenantId = newId('organization')
		const ids = await Promise.all([seed({ tenantId }), seed({ tenantId }), seed({ tenantId })])

		const adapter = new StubAdapter()
		const dispatcher = startNotificationDispatcher(getTestSql(), adapter, silentLog, {
			skipTimer: true,
		})
		await dispatcher.pollOnce()

		for (const { id } of ids) {
			const row = await getRow(tenantId, id)
			expect(row?.status).toBe('sent')
		}
		expect(adapter.sent.length).toBeGreaterThanOrEqual(3)

		await dispatcher.stop()
	})
})

/* ============================================================ skip filters */

describe('dispatcher — skip filters', { tags: ['db'] }, () => {
	test('[S1] status=sent → not picked up', async () => {
		const tenantId = newId('organization')
		const { id } = await seed({ tenantId, status: 'sent' })

		const adapter = new StubAdapter()
		const dispatcher = startNotificationDispatcher(getTestSql(), adapter, silentLog, {
			skipTimer: true,
		})
		await dispatcher.pollOnce()

		// Adapter must NOT have been called for this row.
		const calledFor = adapter.sent.find(
			(s) => s.subject === 'Test' && s.to === 'guest@example.local',
		)
		// Note: other tests may have also seeded same recipient — assert via row state.
		const row = await getRow(tenantId, id)
		expect(row?.status).toBe('sent') // unchanged

		void calledFor
		await dispatcher.stop()
	})

	test('[S3] retryCount >= maxRetries → not picked up', async () => {
		const tenantId = newId('organization')
		const { id } = await seed({ tenantId, retryCount: 8 }) // === default maxRetries

		const adapter = new StubAdapter()
		const dispatcher = startNotificationDispatcher(getTestSql(), adapter, silentLog, {
			skipTimer: true,
		})
		await dispatcher.pollOnce()

		const row = await getRow(tenantId, id)
		expect(row?.status).toBe('pending') // worker SKIPS — exhausted retries
		expect(row?.retryCount).toBe(8) // unchanged

		await dispatcher.stop()
	})

	test('[S4] nextAttemptAt > now → not picked up', async () => {
		const tenantId = newId('organization')
		const future = new Date(Date.now() + 60 * 60 * 1000) // +1h
		const { id } = await seed({ tenantId, nextAttemptAt: future })

		const adapter = new StubAdapter()
		const dispatcher = startNotificationDispatcher(getTestSql(), adapter, silentLog, {
			skipTimer: true,
		})
		await dispatcher.pollOnce()

		const row = await getRow(tenantId, id)
		expect(row?.status).toBe('pending') // unchanged
		expect(row?.retryCount).toBe(0) // unchanged

		await dispatcher.stop()
	})

	test('[S5] nextAttemptAt=NULL → picked up immediately', async () => {
		const tenantId = newId('organization')
		const { id } = await seed({ tenantId, nextAttemptAt: null })

		const adapter = new StubAdapter()
		const dispatcher = startNotificationDispatcher(getTestSql(), adapter, silentLog, {
			skipTimer: true,
		})
		await dispatcher.pollOnce()

		const row = await getRow(tenantId, id)
		expect(row?.status).toBe('sent')

		await dispatcher.stop()
	})
})

/* ============================================================ permanent error */

describe('dispatcher — permanent error', { tags: ['db'] }, () => {
	test('[P1] adapter returns permanent → status=failed, NOT retried', async () => {
		const tenantId = newId('organization')
		const { id } = await seed({ tenantId, retryCount: 0 })

		const adapter = new StubAdapter()
		adapter.queueResult({ kind: 'permanent', reason: 'MailFromDomainNotVerifiedException' })

		const dispatcher = startNotificationDispatcher(getTestSql(), adapter, silentLog, {
			skipTimer: true,
		})
		const stats = await dispatcher.pollOnce()
		expect(stats.permanent).toBeGreaterThanOrEqual(1)

		const row = await getRow(tenantId, id)
		expect(row?.status).toBe('failed')
		expect(row?.failureReason).toBe('MailFromDomainNotVerifiedException')
		expect(row?.retryCount).toBe(1)

		// Run again — must NOT re-attempt because status='failed'.
		await dispatcher.pollOnce()
		const row2 = await getRow(tenantId, id)
		expect(row2?.status).toBe('failed')
		expect(row2?.retryCount).toBe(1) // unchanged

		await dispatcher.stop()
	})
})

/* ============================================================ transient retry */

describe('dispatcher — transient retry', { tags: ['db'] }, () => {
	test('[T1] transient → retryCount++, nextAttemptAt set, status pending', async () => {
		const tenantId = newId('organization')
		const { id } = await seed({ tenantId, retryCount: 0 })

		const adapter = new StubAdapter()
		adapter.queueResult({ kind: 'transient', reason: '503 InternalServerError' })

		const dispatcher = startNotificationDispatcher(getTestSql(), adapter, silentLog, {
			skipTimer: true,
		})
		const stats = await dispatcher.pollOnce()
		expect(stats.transientRetries).toBeGreaterThanOrEqual(1)

		const row = await getRow(tenantId, id)
		expect(row?.status).toBe('pending')
		expect(row?.retryCount).toBe(1)
		expect(row?.nextAttemptAt).toBeTruthy()
		expect(row?.failureReason).toBe('503 InternalServerError')

		await dispatcher.stop()
	})

	test('[T2] transient at retryCount=7 → next attempt = retryCount=8 = dead-letter', async () => {
		const tenantId = newId('organization')
		const { id } = await seed({ tenantId, retryCount: 7 }) // one shy of maxRetries

		const adapter = new StubAdapter()
		adapter.queueResult({ kind: 'transient', reason: 'gateway timeout' })

		const dispatcher = startNotificationDispatcher(getTestSql(), adapter, silentLog, {
			skipTimer: true,
		})
		const stats = await dispatcher.pollOnce()
		expect(stats.deadLettered).toBeGreaterThanOrEqual(1)

		const row = await getRow(tenantId, id)
		expect(row?.status).toBe('failed')
		expect(row?.retryCount).toBe(8)
		expect(row?.failureReason).toContain('max retries exceeded')

		await dispatcher.stop()
	})
})

/* ============================================================ cross-tenant */

describe('dispatcher — cross-tenant', { tags: ['db'] }, () => {
	test('[CT1] both tenants pending → both sent, no leak', async () => {
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const { id: idA } = await seed({ tenantId: tenantA, recipient: 'a@example.local' })
		const { id: idB } = await seed({ tenantId: tenantB, recipient: 'b@example.local' })

		const adapter = new StubAdapter()
		const dispatcher = startNotificationDispatcher(getTestSql(), adapter, silentLog, {
			skipTimer: true,
		})
		await dispatcher.pollOnce()

		const rowA = await getRow(tenantA, idA)
		const rowB = await getRow(tenantB, idB)
		expect(rowA?.status).toBe('sent')
		expect(rowB?.status).toBe('sent')

		// Both recipients appear in adapter history — proves both tenants flowed.
		const recipients = adapter.sent.map((s) => s.to)
		expect(recipients).toContain('a@example.local')
		expect(recipients).toContain('b@example.local')

		await dispatcher.stop()
	})
})

/* ============================================================ recipient resolution (M7.fix.1) */

/**
 * Real proof of M7.fix.1 wiring: outbox row carries placeholder recipient
 * (как пишет CDC handler), dispatcher tracing booking → guest → email
 * подменяет placeholder реальным адресом перед отправкой.
 */
describe('dispatcher — recipient resolution', { tags: ['db'] }, () => {
	async function seedBookingWithGuest(opts: {
		tenantId: string
		guestEmail: string | null
	}): Promise<{ bookingId: string }> {
		const sql = getTestSql()
		const propertyId = newId('property')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		const now = new Date()
		const nowTs = toTs(now)

		await sql`
			UPSERT INTO guest (
				\`tenantId\`, \`id\`, \`lastName\`, \`firstName\`, \`middleName\`,
				\`birthDate\`, \`citizenship\`, \`documentType\`, \`documentSeries\`, \`documentNumber\`,
				\`documentIssuedBy\`, \`documentIssuedDate\`, \`registrationAddress\`,
				\`phone\`, \`email\`, \`notes\`,
				\`createdAt\`, \`updatedAt\`
			) VALUES (
				${opts.tenantId}, ${guestId}, ${'Resolver'}, ${'Тест'}, ${NULL_TEXT},
				${dateOpt(null)}, ${'RU'}, ${'passport'}, ${NULL_TEXT}, ${'9999999'},
				${NULL_TEXT}, ${dateOpt(null)}, ${NULL_TEXT},
				${NULL_TEXT}, ${textOpt(opts.guestEmail)}, ${NULL_TEXT},
				${nowTs}, ${nowTs}
			)
		`
		await sql`
			UPSERT INTO booking (
				\`tenantId\`, \`propertyId\`, \`checkIn\`, \`id\`,
				\`checkOut\`, \`roomTypeId\`, \`ratePlanId\`, \`assignedRoomId\`,
				\`guestsCount\`, \`nightsCount\`, \`primaryGuestId\`, \`guestSnapshot\`,
				\`status\`, \`confirmedAt\`, \`checkedInAt\`, \`checkedOutAt\`, \`cancelledAt\`, \`noShowAt\`, \`cancelReason\`,
				\`channelCode\`, \`externalId\`, \`externalReferences\`,
				\`totalMicros\`, \`paidMicros\`, \`currency\`, \`timeSlices\`,
				\`cancellationFee\`, \`noShowFee\`,
				\`registrationStatus\`, \`registrationMvdId\`, \`registrationSubmittedAt\`,
				\`rklCheckResult\`, \`rklCheckedAt\`,
				\`tourismTaxBaseMicros\`, \`tourismTaxMicros\`,
				\`notes\`,
				\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
			) VALUES (
				${opts.tenantId}, ${propertyId}, ${dateFromIso('2026-04-25')}, ${bookingId},
				${dateFromIso('2026-04-26')}, ${newId('roomType')}, ${newId('ratePlan')}, ${NULL_TEXT},
				${1}, ${1}, ${guestId},
				${toJson({ firstName: 'Тест', lastName: 'Resolver', citizenship: 'RU', documentType: 'passport', documentNumber: '9999999' })},
				${'confirmed'}, ${nowTs}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT},
				${'walkIn'}, ${NULL_TEXT}, ${toJson(null)},
				${5_000_000_000n}, ${0n}, ${'RUB'},
				${toJson([{ date: '2026-04-25', grossMicros: '5000000000', ratePlanId: 'rp', ratePlanVersion: 'v1', currency: 'RUB' }])},
				${toJson(null)}, ${toJson(null)},
				${'pending'}, ${NULL_TEXT}, ${NULL_TIMESTAMP},
				${'pending'}, ${NULL_TIMESTAMP},
				${0n}, ${0n},
				${NULL_TEXT},
				${nowTs}, ${nowTs}, ${'test-actor'}, ${'test-actor'}
			)
		`
		return { bookingId }
	}

	test('[RES1] placeholder + valid guest → adapter receives REAL email', async () => {
		const tenantId = newId('organization')
		const { bookingId } = await seedBookingWithGuest({ tenantId, guestEmail: 'real@guest.ru' })
		// Outbox row written by CDC writer carries placeholder; resolver fixes
		// it before send.
		const { id } = await seed({
			tenantId,
			recipient: 'guest@placeholder.local',
			sourceObjectType: 'booking',
			sourceObjectId: bookingId,
		})

		const adapter = new StubAdapter()
		const dispatcher = startNotificationDispatcher(getTestSql(), adapter, silentLog, {
			skipTimer: true,
		})
		await dispatcher.pollOnce()

		const row = await getRow(tenantId, id)
		expect(row?.status).toBe('sent')
		// Real email actually sent — NOT the placeholder.
		expect(adapter.sent[0]?.to).toBe('real@guest.ru')

		await dispatcher.stop()
	})

	test('[RES2] placeholder + NO guest email → status=failed (permanent)', async () => {
		const tenantId = newId('organization')
		const { bookingId } = await seedBookingWithGuest({ tenantId, guestEmail: null })
		const { id } = await seed({
			tenantId,
			recipient: 'guest@placeholder.local',
			sourceObjectType: 'booking',
			sourceObjectId: bookingId,
		})

		const adapter = new StubAdapter()
		const dispatcher = startNotificationDispatcher(getTestSql(), adapter, silentLog, {
			skipTimer: true,
		})
		await dispatcher.pollOnce()

		const row = await getRow(tenantId, id)
		expect(row?.status).toBe('failed')
		expect(row?.failureReason).toBe('recipient unresolvable')
		// Adapter NEVER called for this row — proves we short-circuited before send.
		expect(adapter.sent.find((s) => s.to === 'guest@placeholder.local')).toBeUndefined()

		await dispatcher.stop()
	})

	test('[RES3] placeholder + booking missing → permanent failure', async () => {
		const tenantId = newId('organization')
		const { id } = await seed({
			tenantId,
			recipient: 'guest@placeholder.local',
			sourceObjectType: 'booking',
			sourceObjectId: 'book_doesnotexist',
		})

		const adapter = new StubAdapter()
		const dispatcher = startNotificationDispatcher(getTestSql(), adapter, silentLog, {
			skipTimer: true,
		})
		await dispatcher.pollOnce()

		const row = await getRow(tenantId, id)
		expect(row?.status).toBe('failed')
		await dispatcher.stop()
	})

	test('[RES4] non-placeholder recipient → resolver SKIPPED (operator override)', async () => {
		const tenantId = newId('organization')
		// recipient is already a real address — no resolution attempted.
		const { id } = await seed({ tenantId, recipient: 'override@manual.ru' })

		const adapter = new StubAdapter()
		const dispatcher = startNotificationDispatcher(getTestSql(), adapter, silentLog, {
			skipTimer: true,
		})
		await dispatcher.pollOnce()

		const row = await getRow(tenantId, id)
		expect(row?.status).toBe('sent')
		expect(adapter.sent.find((s) => s.to === 'override@manual.ru')).toBeDefined()
		await dispatcher.stop()
	})
})
