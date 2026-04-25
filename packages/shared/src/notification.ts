import { z } from 'zod'

/**
 * Notification outbox — transactional outbox pattern for guest + ops
 * notifications. Created in the SAME tx as the source state transition
 * (via `notification_writer` CDC handler), surviving crashes and SMTP
 * outages. A separate dispatcher worker reads `WHERE status = 'pending'`
 * and sends through SMTP / SMS / push (Phase 3).
 *
 * Per canon `feedback_no_halfway`: NOT a logger-only stub. Real persisted
 * row + idempotent UNIQUE on `(tenantId, sourceEventDedupKey)`.
 */

/* --------------------------------------------------------------- enums + SM */

const notificationKindValues = [
	'payment_succeeded',
	'payment_failed',
	'receipt_confirmed',
	'receipt_failed',
] as const
export const notificationKindSchema = z.enum(notificationKindValues)
export type NotificationKind = z.infer<typeof notificationKindSchema>

const notificationChannelValues = ['email', 'sms', 'push'] as const
export const notificationChannelSchema = z.enum(notificationChannelValues)
export type NotificationChannel = z.infer<typeof notificationChannelSchema>

const notificationStatusValues = ['pending', 'sent', 'failed'] as const
export const notificationStatusSchema = z.enum(notificationStatusValues)
export type NotificationStatus = z.infer<typeof notificationStatusSchema>

/** Terminal states (no further transition). */
export const TERMINAL_NOTIFICATION_STATUSES: readonly NotificationStatus[] = [
	'sent',
	'failed',
] as const

/* --------------------------------------------------------------- domain row */

export type Notification = {
	tenantId: string
	id: string
	kind: NotificationKind
	channel: NotificationChannel
	recipient: string
	subject: string
	bodyText: string | null
	payloadJson: unknown
	status: NotificationStatus
	sentAt: string | null
	failedAt: string | null
	failureReason: string | null
	retryCount: number
	sourceObjectType: string
	sourceObjectId: string
	sourceEventDedupKey: string
	createdAt: string
	updatedAt: string
	createdBy: string
	updatedBy: string
}

/* --------------------------------------------------------------- helpers */

/**
 * Build the deterministic dedup key. UNIQUE per tenant on the
 * `ixNotificationDedup` index — same source-object + kind never produces
 * two rows. Same separator-char convention as
 * `synthesizeYookassaDedupKey`.
 */
export function buildNotificationDedupKey(args: {
	sourceObjectType: 'payment' | 'receipt'
	sourceObjectId: string
	kind: NotificationKind
}): string {
	return `${args.sourceObjectType}:${args.sourceObjectId}:${args.kind}`
}
