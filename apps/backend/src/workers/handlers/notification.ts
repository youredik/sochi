/**
 * `notification_writer` CDC handler — transactional-outbox writer for
 * guest + ops notifications.
 *
 * Per canon `feedback_no_halfway` — NOT a logger-only stub. Persists a real
 * `notificationOutbox` row that survives crashes; a separate dispatcher
 * worker (Phase 3) reads pending rows and sends via SMTP / SMS / push.
 *
 * Trigger sources (registered via migration 0015):
 *   - `payment/payment_events`:
 *       payment.status → 'succeeded' (oldImage.status !== 'succeeded')
 *         → kind='payment_succeeded'  (guest receipt link)
 *       payment.status → 'failed'   (oldImage.status !== 'failed')
 *         → kind='payment_failed'    (ops alert)
 *   - `receipt/receipt_events`:
 *       receipt.status → 'confirmed' (oldImage.status !== 'confirmed')
 *         → kind='receipt_confirmed'  (guest QR-код email per 54-ФЗ)
 *       receipt.status → 'failed'    (oldImage.status !== 'failed')
 *         → kind='receipt_failed'     (ops fiscal alert)
 *
 * Idempotency:
 *   `ixNotificationDedup` UNIQUE on `(tenantId, sourceEventDedupKey)`.
 *   `dedupKey = '<sourceObjectType>:<sourceObjectId>:<kind>'`.
 *   SELECT-then-UPSERT pre-check inside tx (avoids YDB tx-poison-on-PK
 *   pattern, same approach as refund-creator handler).
 *
 * V1 recipient: placeholder addresses. Real recipient resolution
 * (booking.guest.email, organization.opsEmail, etc.) is wired at the
 * dispatcher worker in Phase 3 — keeping the handler decoupled from
 * the guest/property domain reads. The outbox row carries source pointers
 * so the worker can resolve at send time.
 */

import { buildNotificationDedupKey, type NotificationKind, newId } from '@horeca/shared'
import type { TX } from '@ydbjs/query'
import { NULL_TEXT, NULL_TIMESTAMP, toJson, toTs } from '../../db/ydb-helpers.ts'
import type { CdcEvent } from '../cdc-handlers.ts'
import type { HandlerLogger } from './refund-creator.ts'

const NOTIFICATION_WRITER_ACTOR_ID = 'system:notification_writer'

/** Source topic the handler is wired to — selects the dispatch table. */
export type NotificationSource = 'payment' | 'receipt'

/**
 * Map (source, statusTransition) → notification kind. Returns null if the
 * transition does not warrant a notification.
 */
function deriveKind(
	source: NotificationSource,
	newStatus: string | undefined,
	oldStatus: string | undefined,
): NotificationKind | null {
	if (newStatus === oldStatus) return null
	if (source === 'payment') {
		if (newStatus === 'succeeded') return 'payment_succeeded'
		if (newStatus === 'failed') return 'payment_failed'
	} else if (source === 'receipt') {
		if (newStatus === 'confirmed') return 'receipt_confirmed'
		if (newStatus === 'failed') return 'receipt_failed'
	}
	return null
}

/**
 * Build subject + recipient placeholder per kind. V1 stub addresses; the
 * dispatcher worker (Phase 3) will resolve real recipients via guest /
 * organization lookups.
 */
function buildOutboxFields(kind: NotificationKind): {
	subject: string
	recipient: string
	channel: 'email'
} {
	switch (kind) {
		case 'payment_succeeded':
			return { subject: 'Чек об оплате', recipient: 'guest@placeholder.local', channel: 'email' }
		case 'payment_failed':
			return { subject: 'Платёж не прошёл', recipient: 'ops@placeholder.local', channel: 'email' }
		case 'receipt_confirmed':
			return { subject: 'Фискальный чек', recipient: 'guest@placeholder.local', channel: 'email' }
		case 'receipt_failed':
			return { subject: 'ОФД ошибка', recipient: 'ops@placeholder.local', channel: 'email' }
		// M7.B.3 kinds — handler scope is payment/receipt CDC only; these are
		// produced by other writers (booking-confirmed CDC + cron-driven), but
		// the enum is shared. Defensive return so the union is exhaustive.
		case 'booking_confirmed':
			return {
				subject: 'Бронирование подтверждено',
				recipient: 'guest@placeholder.local',
				channel: 'email',
			}
		case 'checkin_reminder':
			return {
				subject: 'Напоминание о заезде',
				recipient: 'guest@placeholder.local',
				channel: 'email',
			}
		case 'review_request':
			return {
				subject: 'Поделитесь впечатлениями',
				recipient: 'guest@placeholder.local',
				channel: 'email',
			}
	}
}

/**
 * Build a notification CDC handler bound to a single source topic.
 */
export function createNotificationHandler(log: HandlerLogger, source: NotificationSource) {
	return async (tx: TX, event: CdcEvent): Promise<void> => {
		if (!event.newImage) return // DELETE — no notification trigger
		const newStatus = event.newImage.status as string | undefined
		const oldStatus = event.oldImage?.status as string | undefined
		const kind = deriveKind(source, newStatus, oldStatus)
		if (!kind) return

		const key = event.key ?? []
		// payment PK 4D: (tenantId, propertyId, bookingId, paymentId) → key[0], key[3]
		// receipt PK 3D: (tenantId, paymentId, receiptId)              → key[0], key[2]
		const sourceIdSlot = source === 'payment' ? 3 : 2
		if (key[0] === undefined || key[sourceIdSlot] === undefined) {
			log.warn({ source, key }, 'notification_writer: malformed event key — skipping')
			return
		}
		const tenantId = String(key[0])
		const sourceObjectId = String(key[sourceIdSlot])

		const dedupKey = buildNotificationDedupKey({
			sourceObjectType: source,
			sourceObjectId,
			kind,
		})

		// SELECT-then-UPSERT pre-check (canonical YDB tx-safe dedup).
		const [existing = []] = await tx<{ x: number }[]>`
			SELECT 1 AS x FROM notificationOutbox VIEW ixNotificationDedup
			WHERE tenantId = ${tenantId} AND sourceEventDedupKey = ${dedupKey}
			LIMIT 1
		`
		if (existing.length > 0) {
			log.debug(
				{ tenantId, dedupKey },
				'notification_writer: dedup row already exists — idempotent skip',
			)
			return
		}

		const id = newId('notification')
		const now = new Date()
		const nowTs = toTs(now)
		const { subject, recipient, channel } = buildOutboxFields(kind)
		const payloadJson = {
			source,
			sourceObjectId,
			oldStatus: oldStatus ?? null,
			newStatus: newStatus ?? null,
		}

		await tx`
			UPSERT INTO notificationOutbox (
				\`tenantId\`, \`id\`,
				\`kind\`, \`channel\`, \`recipient\`, \`subject\`, \`bodyText\`, \`payloadJson\`,
				\`status\`,
				\`sentAt\`, \`failedAt\`, \`failureReason\`, \`retryCount\`,
				\`sourceObjectType\`, \`sourceObjectId\`, \`sourceEventDedupKey\`,
				\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
			) VALUES (
				${tenantId}, ${id},
				${kind}, ${channel}, ${recipient}, ${subject}, ${NULL_TEXT}, ${toJson(payloadJson)},
				${'pending'},
				${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT}, ${0},
				${source}, ${sourceObjectId}, ${dedupKey},
				${nowTs}, ${nowTs}, ${NOTIFICATION_WRITER_ACTOR_ID}, ${NOTIFICATION_WRITER_ACTOR_ID}
			)
		`

		log.info(
			{ tenantId, source, sourceObjectId, kind, dedupKey },
			'notification_writer: outbox row created',
		)
	}
}
