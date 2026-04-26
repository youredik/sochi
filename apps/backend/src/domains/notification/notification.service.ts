/**
 * Notification service — admin console facade.
 *
 *   - `list` / `getById` — pass-through to repo.
 *   - `getDetail(id)` — composes drill-down view: row + computed last-attempt
 *     timeline derived from row state. V1 has no per-attempt history table
 *     (extension reserved for M9); the shape lets UI render with one or many
 *     attempts uniformly.
 *   - `markForRetry(id, actorUserId)` — UPSERT row to `pending`, write an
 *     activity-log entry capturing operator action (canon
 *     `project_event_architecture.md` — polymorphic activity table is the
 *     single source of audit truth).
 */

import type {
	NotificationAttempt,
	NotificationDetail,
	NotificationListPage,
	NotificationListParams,
} from '@horeca/shared'
import type { ActivityRepo } from '../activity/activity.repo.ts'
import type { NotificationRepo } from './notification.repo.ts'

export type NotificationService = {
	list: (tenantId: string, opts: NotificationListParams) => Promise<NotificationListPage>
	getDetail: (tenantId: string, id: string) => Promise<NotificationDetail | null>
	markForRetry: (tenantId: string, id: string, actorUserId: string) => Promise<NotificationDetail>
}

export function createNotificationService(
	repo: NotificationRepo,
	activityRepo: ActivityRepo,
): NotificationService {
	return {
		list: (tenantId, opts) => repo.list(tenantId, opts),

		async getDetail(tenantId, id): Promise<NotificationDetail | null> {
			const row = await repo.getById(tenantId, id)
			if (!row) return null
			return composeDetail(row)
		},

		async markForRetry(tenantId, id, actorUserId): Promise<NotificationDetail> {
			const updated = await repo.markForRetry(tenantId, id, actorUserId)
			// Activity-log entry — operator-triggered manual retry. Audit trail
			// canonical (memory `project_event_architecture.md`).
			await activityRepo.insert({
				tenantId,
				objectType: 'notification',
				recordId: id,
				activityType: 'manualRetry',
				actorUserId,
				diffJson: {
					action: 'manual_retry',
					retryCount_before: null, // repo reset to 0; operator sees activity-log count
					nextStatus: updated.status,
				},
			})
			return composeDetail(updated)
		},
	}
}

/**
 * Build the detail-view shape from a row. V1: derive last-attempt entry
 * from `sentAt`/`failedAt`/`failureReason`. Phase 2 will read from a
 * `notification_attempt` table and concat full history.
 */
function composeDetail(
	row: import('@horeca/shared').Notification & {
		nextAttemptAt?: string | null
		messageId?: string | null
	},
): NotificationDetail {
	const attempts: NotificationAttempt[] = []
	if (row.status === 'sent' && row.sentAt) {
		attempts.push({ kind: 'sent', at: row.sentAt, reason: null })
	} else if (row.status === 'failed' && row.failedAt) {
		// Differentiate transient-exhausted vs permanent — current schema does
		// not preserve that distinction (both end up as 'failed'). For V1 we
		// flag as `permanent_failure` (terminal); future telemetry can split.
		attempts.push({
			kind: 'permanent_failure',
			at: row.failedAt,
			reason: row.failureReason,
		})
	} else if (row.status === 'pending' && row.failureReason) {
		// Transient retry в полёте — last attempt failed, dispatcher scheduled
		// next via nextAttemptAt.
		attempts.push({
			kind: 'transient_failure',
			at: row.updatedAt,
			reason: row.failureReason,
		})
	}
	return {
		notification: row,
		attempts,
		nextAttemptAt: row.nextAttemptAt ?? null,
		messageId: row.messageId ?? null,
	}
}
