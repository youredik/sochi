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
	// M7.B.3 — booking lifecycle + cron-driven guest engagement.
	'booking_confirmed',
	'checkin_reminder',
	'review_request',
	// M8.A.0.6 — public-widget guest journey (research §10.3 / §10.6 / §10.7).
	'pre_arrival',
	'booking_cancelled',
	'booking_modified',
	// M9.widget.5 / A3.1.c — magic-link delivery for guest-portal access (find-by-ref-email flow).
	'booking_magic_link',
] as const
export const notificationKindSchema = z.enum(notificationKindValues)
export type NotificationKind = z.infer<typeof notificationKindSchema>

const notificationChannelValues = ['email', 'sms', 'push'] as const
export const notificationChannelSchema = z.enum(notificationChannelValues)
export type NotificationChannel = z.infer<typeof notificationChannelSchema>

const notificationStatusValues = ['pending', 'sent', 'failed'] as const
export const notificationStatusSchema = z.enum(notificationStatusValues)
export type NotificationStatus = z.infer<typeof notificationStatusSchema>

/**
 * Recipient kind — distinguishes who receives the notification:
 *   - `user`    — internal operator/staff member of the property
 *   - `guest`   — public-widget customer (booking holder)
 *   - `system`  — ops alerts (no human recipient; logs/Sentry)
 *   - `channel` — channel-manager / OTA endpoint (B2B push)
 *
 * Per plan v2 §7.1 #5: drives downstream recipient-resolver routing
 * (different DPA / unsubscribe / SMS short-codes per kind).
 */
const notificationRecipientKindValues = ['user', 'guest', 'system', 'channel'] as const
export const notificationRecipientKindSchema = z.enum(notificationRecipientKindValues)
export type NotificationRecipientKind = z.infer<typeof notificationRecipientKindSchema>

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
	/**
	 * Routing dimension — `user` | `guest` | `system` | `channel`. Nullable
	 * for backwards compat with rows written by M7.* before recipientKind was
	 * added (migration 0032 ADD COLUMN). New rows MUST set it; service layer
	 * fills based on source-object lookup.
	 */
	recipientKind: NotificationRecipientKind | null
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
export type NotificationSourceObjectType = 'payment' | 'receipt' | 'booking'

export function buildNotificationDedupKey(args: {
	sourceObjectType: NotificationSourceObjectType
	sourceObjectId: string
	kind: NotificationKind
}): string {
	return `${args.sourceObjectType}:${args.sourceObjectId}:${args.kind}`
}

/**
 * Default `recipientKind` for a given `kind`. Used by M7 writers
 * (CDC handler + cron) so existing rows are routed correctly without
 * service-layer override.
 *
 *   - guest-facing receipts/confirmations/reminders → `guest`
 *   - ops alerts (payment failure, ОФД failure)     → `system`
 *
 * Channel-manager / OTA push notifications use `channel` — those flow
 * via separate M8.C writers, not this default.
 */
export function deriveRecipientKindFromNotificationKind(
	kind: NotificationKind,
): NotificationRecipientKind {
	switch (kind) {
		case 'payment_failed':
		case 'receipt_failed':
			return 'system'
		case 'payment_succeeded':
		case 'receipt_confirmed':
		case 'booking_confirmed':
		case 'checkin_reminder':
		case 'review_request':
		case 'pre_arrival':
		case 'booking_cancelled':
		case 'booking_modified':
		case 'booking_magic_link':
			return 'guest'
	}
}

/* ---------------------------------------- Admin console — listing + retry */

/**
 * Listing query params для `GET /api/admin/notifications`. Все фильтры
 * optional + AND-combined. Cursor-based pagination — UI loads first page
 * then `?cursor=...` for next.
 *
 * Date filters bound by `createdAt` (when row was first written by CDC
 * handler) — это natural-seeking ordering для operator triage. `sentAt` /
 * `failedAt` are state-transition timestamps; useful for drill-down но не
 * для timeline browse.
 */
export const notificationListParams = z
	.object({
		status: notificationStatusSchema.optional(),
		kind: notificationKindSchema.optional(),
		recipient: z.string().min(1).max(320).optional(),
		from: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
			.optional(),
		to: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
			.optional(),
		cursor: z.string().min(1).max(200).optional(),
		limit: z.coerce.number().int().min(1).max(100).default(50),
	})
	.refine((v) => !v.from || !v.to || v.from <= v.to, 'from must be <= to')
export type NotificationListParams = z.infer<typeof notificationListParams>

/** Single page of admin listing — cursor for next, null when exhausted. */
export type NotificationListPage = {
	items: Notification[]
	/** Opaque cursor for the next page; null when no more rows. */
	nextCursor: string | null
}

/**
 * Path param schema for `/api/admin/notifications/:id:retry` and `:id`.
 * Reuses TypedID prefix `ntf_` (matches `newId('notification')`).
 */
export const notificationIdParam = z.object({
	id: z.string().regex(/^ntf_[a-z0-9]+$/i, 'Expected ntf_* TypedID'),
})
export type NotificationIdParam = z.infer<typeof notificationIdParam>

/**
 * Detail view for drill-down sheet — row + computed retry-timeline-summary.
 * V1 shows last-attempt context (no per-attempt history table); design
 * reserves shape so M9 can populate `attempts[]` from a future
 * `notification_attempt` table without UI churn.
 */
export type NotificationDetail = {
	notification: Notification
	/**
	 * Last-attempt context — derived from row state. Order: most-recent first.
	 *
	 * V1 has at most ONE entry (the last failure or last send). Phase 2
	 * extends with full per-attempt audit trail.
	 */
	attempts: NotificationAttempt[]
	/** Next scheduled retry (transient backoff). Null when sent/failed/no schedule. */
	nextAttemptAt: string | null
	/** Postbox/SES MessageId for the successful send (when status='sent'). */
	messageId: string | null
}

export type NotificationAttempt = {
	/** Outcome of the attempt. */
	kind: 'sent' | 'transient_failure' | 'permanent_failure'
	/** ISO timestamp of the attempt completion. */
	at: string
	/** Failure reason (transient_failure / permanent_failure). Null on sent. */
	reason: string | null
}
