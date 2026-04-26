/**
 * Pure helpers extracted from `notification-detail-sheet.tsx` so the
 * critical retry-gate logic can be strict-tested without QueryClient /
 * Suspense / mutation plumbing.
 *
 *   `deriveRetryGate({ status, canRetry })` → { enabled, reason }
 *     Three cases:
 *       1. status === 'sent'                  → not enabled, "already sent" reason
 *       2. !canRetry (RBAC denies)            → not enabled, "role required" reason
 *       3. otherwise                          → enabled, no reason (button shows)
 *
 *   `attemptBadgeLabel(kind)` → RU label per attempt outcome.
 */

export interface RetryGate {
	enabled: boolean
	/** Tooltip text — shown when `enabled === false`. Null when button enabled. */
	reason: string | null
}

export function deriveRetryGate({
	status,
	canRetry,
}: {
	status: string
	canRetry: boolean
}): RetryGate {
	if (status === 'sent') {
		return {
			enabled: false,
			reason: 'Уведомление уже отправлено — повторить нельзя',
		}
	}
	if (!canRetry) {
		return {
			enabled: false,
			reason: 'Повторная отправка: требуется роль Менеджер или Владелец',
		}
	}
	return { enabled: true, reason: null }
}

export type AttemptKind = 'sent' | 'transient_failure' | 'permanent_failure'

export interface AttemptBadgeConf {
	label: string
	variant: 'secondary' | 'outline' | 'destructive'
}

export function attemptBadgeConf(kind: AttemptKind): AttemptBadgeConf {
	if (kind === 'sent') return { label: 'Отправлено', variant: 'secondary' }
	if (kind === 'transient_failure') return { label: 'Временная ошибка', variant: 'outline' }
	return { label: 'Постоянная ошибка', variant: 'destructive' }
}
