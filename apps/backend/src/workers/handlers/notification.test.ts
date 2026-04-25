/**
 * `notification_writer` CDC handler — integration tests. Production-grade.
 *
 * **Pre-done audit checklist (FROM START — feedback_pre_done_audit.md):**
 *
 *   Trigger gate (only fresh transitions emit):
 *     [T1] payment INSERT status=succeeded → kind=payment_succeeded row
 *     [T2] payment UPDATE pending → succeeded → kind=payment_succeeded
 *     [T3] payment UPDATE succeeded → succeeded (redelivery) → no row
 *     [T4] payment UPDATE pending → failed → kind=payment_failed
 *     [T5] payment UPDATE pending → canceled → no row (only succeeded/failed kinds)
 *     [T6] receipt UPDATE pending → confirmed → kind=receipt_confirmed
 *     [T7] receipt UPDATE pending → failed → kind=receipt_failed
 *     [T8] DELETE event (no newImage) → no row
 *     [T9] empty key → skip
 *
 *   Idempotency (canon — UNIQUE dedup):
 *     [ID1] same event 2× → exactly one outbox row
 *     [ID2] cross-tenant SAME source id + kind → both rows created (tenant-scoped)
 *
 *   Outbox payload correctness:
 *     [P1] sourceObjectType matches handler source ('payment' or 'receipt')
 *     [P2] sourceObjectId from PK key slot
 *     [P3] sourceEventDedupKey == `<source>:<id>:<kind>`
 *     [P4] status='pending', retryCount=0
 *     [P5] kind correctly mapped from status transition
 *     [P6] payloadJson contains source/sourceObjectId/oldStatus/newStatus
 *
 *   Cross-tenant isolation:
 *     [CT1] handler call in tenantA does not create row in tenantB
 *
 *   Audit fields:
 *     [A1] createdBy = updatedBy = 'system:notification_writer'
 *
 * Requires local YDB + migrations 0007-0017 applied.
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import type { CdcEvent } from '../cdc-handlers.ts'
import { createNotificationHandler, type NotificationSource } from './notification.ts'

beforeAll(async () => {
	await setupTestDb()
})
afterAll(async () => {
	await teardownTestDb()
})

const silentLog = { debug: () => {}, info: () => {}, warn: () => {} }
const handlers: Record<NotificationSource, ReturnType<typeof createNotificationHandler>> = {
	payment: createNotificationHandler(silentLog, 'payment'),
	receipt: createNotificationHandler(silentLog, 'receipt'),
}

function buildPaymentEvent(args: {
	tenantId: string
	propertyId?: string
	bookingId?: string
	paymentId: string
	oldStatus?: string | null
	newStatus?: string | null
}): CdcEvent {
	const event: CdcEvent = {
		key: [
			args.tenantId,
			args.propertyId ?? newId('property'),
			args.bookingId ?? newId('booking'),
			args.paymentId,
		],
	}
	if (args.newStatus !== null && args.newStatus !== undefined) {
		event.newImage = { status: args.newStatus, updatedBy: 'system' }
	}
	if (args.oldStatus !== null && args.oldStatus !== undefined) {
		event.oldImage = { status: args.oldStatus, updatedBy: 'system' }
	}
	return event
}

function buildReceiptEvent(args: {
	tenantId: string
	paymentId?: string
	receiptId: string
	oldStatus?: string | null
	newStatus?: string | null
}): CdcEvent {
	const event: CdcEvent = {
		key: [args.tenantId, args.paymentId ?? newId('payment'), args.receiptId],
	}
	if (args.newStatus !== null && args.newStatus !== undefined) {
		event.newImage = { status: args.newStatus, updatedBy: 'system' }
	}
	if (args.oldStatus !== null && args.oldStatus !== undefined) {
		event.oldImage = { status: args.oldStatus, updatedBy: 'system' }
	}
	return event
}

async function runHandler(source: NotificationSource, event: CdcEvent): Promise<void> {
	const sql = getTestSql()
	await sql.begin({ idempotent: true }, async (tx) => {
		await handlers[source](tx, event)
	})
}

async function findNotificationByDedup(
	tenantId: string,
	dedupKey: string,
): Promise<
	Array<{
		id: string
		kind: string
		channel: string
		subject: string
		status: string
		retryCount: number
		sourceObjectType: string
		sourceObjectId: string
		createdBy: string
		updatedBy: string
		payloadJson: unknown
	}>
> {
	const sql = getTestSql()
	const [rows = []] = await sql<
		Array<{
			id: string
			kind: string
			channel: string
			subject: string
			status: string
			retryCount: number | bigint
			sourceObjectType: string
			sourceObjectId: string
			createdBy: string
			updatedBy: string
			payloadJson: unknown
		}>
	>`SELECT id, kind, channel, subject, status, retryCount, sourceObjectType,
		sourceObjectId, createdBy, updatedBy, payloadJson
	  FROM notificationOutbox VIEW ixNotificationDedup
	  WHERE tenantId = ${tenantId} AND sourceEventDedupKey = ${dedupKey}`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	return rows.map((r) => ({
		id: r.id,
		kind: r.kind,
		channel: r.channel,
		subject: r.subject,
		status: r.status,
		retryCount: Number(r.retryCount),
		sourceObjectType: r.sourceObjectType,
		sourceObjectId: r.sourceObjectId,
		createdBy: r.createdBy,
		updatedBy: r.updatedBy,
		payloadJson: r.payloadJson,
	}))
}

describe('notification_writer — payment trigger semantics', { tags: ['db'] }, () => {
	test('[T1] INSERT status=succeeded → outbox row kind=payment_succeeded', async () => {
		const tenantId = newId('organization')
		const paymentId = newId('payment')
		await runHandler(
			'payment',
			buildPaymentEvent({ tenantId, paymentId, oldStatus: null, newStatus: 'succeeded' }),
		)
		const rows = await findNotificationByDedup(tenantId, `payment:${paymentId}:payment_succeeded`)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.kind).toBe('payment_succeeded')
	})

	test('[T2] UPDATE pending → succeeded → row created', async () => {
		const tenantId = newId('organization')
		const paymentId = newId('payment')
		await runHandler(
			'payment',
			buildPaymentEvent({ tenantId, paymentId, oldStatus: 'pending', newStatus: 'succeeded' }),
		)
		const rows = await findNotificationByDedup(tenantId, `payment:${paymentId}:payment_succeeded`)
		expect(rows).toHaveLength(1)
	})

	test('[T3] UPDATE succeeded → succeeded (redelivery) → no row', async () => {
		const tenantId = newId('organization')
		const paymentId = newId('payment')
		await runHandler(
			'payment',
			buildPaymentEvent({ tenantId, paymentId, oldStatus: 'succeeded', newStatus: 'succeeded' }),
		)
		const rows = await findNotificationByDedup(tenantId, `payment:${paymentId}:payment_succeeded`)
		expect(rows).toHaveLength(0)
	})

	test('[T4] UPDATE pending → failed → row kind=payment_failed', async () => {
		const tenantId = newId('organization')
		const paymentId = newId('payment')
		await runHandler(
			'payment',
			buildPaymentEvent({ tenantId, paymentId, oldStatus: 'pending', newStatus: 'failed' }),
		)
		const rows = await findNotificationByDedup(tenantId, `payment:${paymentId}:payment_failed`)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.kind).toBe('payment_failed')
	})

	test('[T5] UPDATE pending → canceled → no row (no notification kind)', async () => {
		const tenantId = newId('organization')
		const paymentId = newId('payment')
		await runHandler(
			'payment',
			buildPaymentEvent({ tenantId, paymentId, oldStatus: 'pending', newStatus: 'canceled' }),
		)
		const sql = getTestSql()
		const [rows = []] = await sql<{ count: number | bigint }[]>`
			SELECT COUNT(*) AS count FROM notificationOutbox
			WHERE tenantId = ${tenantId} AND sourceObjectId = ${paymentId}
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		expect(Number(rows[0]?.count ?? 0)).toBe(0)
	})

	test('receipt UPDATE pending → sent → no row (only confirmed/failed kinds)', async () => {
		// duplicate guard test moved here from receipt block to avoid
		// pollution; explicit assertion below.
		const tenantId = newId('organization')
		const receiptId = newId('receipt')
		await runHandler(
			'receipt',
			buildReceiptEvent({ tenantId, receiptId, oldStatus: 'pending', newStatus: 'sent' }),
		)
		const sql = getTestSql()
		const [rows2 = []] = await sql<{ count: number | bigint }[]>`
			SELECT COUNT(*) AS count FROM notificationOutbox
			WHERE tenantId = ${tenantId} AND sourceObjectId = ${receiptId}
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		expect(Number(rows2[0]?.count ?? 0)).toBe(0)
	})

	test('[T8] DELETE event (no newImage) → no row', async () => {
		const tenantId = newId('organization')
		const paymentId = newId('payment')
		await runHandler('payment', {
			key: [tenantId, newId('property'), newId('booking'), paymentId],
			oldImage: { status: 'succeeded', updatedBy: 'system' },
		})
		const rows = await findNotificationByDedup(tenantId, `payment:${paymentId}:payment_succeeded`)
		expect(rows).toHaveLength(0)
	})

	test('[T9] empty key → skip', async () => {
		await runHandler('payment', { key: [], newImage: { status: 'succeeded' } })
		expect(true).toBe(true) // no throw
	})
})

describe('notification_writer — receipt trigger semantics', { tags: ['db'] }, () => {
	test('[T6] receipt UPDATE pending → confirmed → kind=receipt_confirmed', async () => {
		const tenantId = newId('organization')
		const receiptId = newId('receipt')
		await runHandler(
			'receipt',
			buildReceiptEvent({ tenantId, receiptId, oldStatus: 'pending', newStatus: 'confirmed' }),
		)
		const rows = await findNotificationByDedup(tenantId, `receipt:${receiptId}:receipt_confirmed`)
		expect(rows).toHaveLength(1)
	})

	test('[T7] receipt UPDATE pending → failed → kind=receipt_failed', async () => {
		const tenantId = newId('organization')
		const receiptId = newId('receipt')
		await runHandler(
			'receipt',
			buildReceiptEvent({ tenantId, receiptId, oldStatus: 'pending', newStatus: 'failed' }),
		)
		const rows = await findNotificationByDedup(tenantId, `receipt:${receiptId}:receipt_failed`)
		expect(rows).toHaveLength(1)
	})

	test('receipt UPDATE pending → sent → no row (only confirmed/failed kinds)', async () => {
		const tenantId = newId('organization')
		const receiptId = newId('receipt')
		await runHandler(
			'receipt',
			buildReceiptEvent({ tenantId, receiptId, oldStatus: 'pending', newStatus: 'sent' }),
		)
		const sql = getTestSql()
		const [rows = []] = await sql<{ count: number | bigint }[]>`
			SELECT COUNT(*) AS count FROM notificationOutbox
			WHERE tenantId = ${tenantId} AND sourceObjectId = ${receiptId}
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		expect(Number(rows[0]?.count ?? 0)).toBe(0)
	})
})

describe('notification_writer — idempotency', { tags: ['db'] }, () => {
	test('[ID1] same event 2× → exactly one outbox row', async () => {
		const tenantId = newId('organization')
		const paymentId = newId('payment')
		const event = buildPaymentEvent({
			tenantId,
			paymentId,
			oldStatus: 'pending',
			newStatus: 'succeeded',
		})
		await runHandler('payment', event)
		await runHandler('payment', event)
		const rows = await findNotificationByDedup(tenantId, `payment:${paymentId}:payment_succeeded`)
		expect(rows).toHaveLength(1)
	})

	test('[ID2] cross-tenant SAME paymentId+kind → both rows created', async () => {
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const paymentId = newId('payment') // same ID across tenants
		await runHandler(
			'payment',
			buildPaymentEvent({
				tenantId: tenantA,
				paymentId,
				oldStatus: 'pending',
				newStatus: 'succeeded',
			}),
		)
		await runHandler(
			'payment',
			buildPaymentEvent({
				tenantId: tenantB,
				paymentId,
				oldStatus: 'pending',
				newStatus: 'succeeded',
			}),
		)
		const rowsA = await findNotificationByDedup(tenantA, `payment:${paymentId}:payment_succeeded`)
		const rowsB = await findNotificationByDedup(tenantB, `payment:${paymentId}:payment_succeeded`)
		expect(rowsA).toHaveLength(1)
		expect(rowsB).toHaveLength(1)
		expect(rowsA[0]?.id).not.toBe(rowsB[0]?.id) // different rows
	})
})

describe('notification_writer — outbox payload correctness', { tags: ['db'] }, () => {
	test('[P1-P6,A1] all key fields populated correctly', async () => {
		const tenantId = newId('organization')
		const paymentId = newId('payment')
		await runHandler(
			'payment',
			buildPaymentEvent({ tenantId, paymentId, oldStatus: 'pending', newStatus: 'succeeded' }),
		)
		const rows = await findNotificationByDedup(tenantId, `payment:${paymentId}:payment_succeeded`)
		expect(rows).toHaveLength(1)
		const r = rows[0]
		if (!r) throw new Error('expected one row')

		// P1
		expect(r.sourceObjectType).toBe('payment')
		// P2
		expect(r.sourceObjectId).toBe(paymentId)
		// P4
		expect(r.status).toBe('pending')
		expect(r.retryCount).toBe(0)
		// P5
		expect(r.kind).toBe('payment_succeeded')
		// P6
		expect(r.payloadJson).toMatchObject({
			source: 'payment',
			sourceObjectId: paymentId,
			oldStatus: 'pending',
			newStatus: 'succeeded',
		})
		// A1
		expect(r.createdBy).toBe('system:notification_writer')
		expect(r.updatedBy).toBe('system:notification_writer')
	})
})

describe('notification_writer — cross-tenant isolation', { tags: ['db'] }, () => {
	test('[CT1] handler in tenantA does not create row in tenantB', async () => {
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const paymentId = newId('payment')
		await runHandler(
			'payment',
			buildPaymentEvent({
				tenantId: tenantA,
				paymentId,
				oldStatus: 'pending',
				newStatus: 'succeeded',
			}),
		)
		const rowsB = await findNotificationByDedup(tenantB, `payment:${paymentId}:payment_succeeded`)
		expect(rowsB).toHaveLength(0)
	})
})
