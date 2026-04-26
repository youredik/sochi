/**
 * RU labels for notification status + kind — pure mapping helpers.
 *
 * Same defensive-fallback pattern as `admin-tax/lib/booking-labels.ts`:
 * unknown enum value returns raw code (so a backend-added value surfaces
 * to operator instead of being silently misclassified).
 */

export type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive'

export interface StatusBadgeConf {
	label: string
	variant: BadgeVariant
}

const STATUS_LABEL: Record<string, StatusBadgeConf> = {
	pending: { label: 'В очереди', variant: 'outline' },
	sent: { label: 'Отправлено', variant: 'secondary' },
	failed: { label: 'Ошибка', variant: 'destructive' },
}

/** Returns a FRESH object every call — no shared mutable state. */
export function notificationStatusBadge(status: string): StatusBadgeConf {
	const conf = STATUS_LABEL[status]
	if (conf) return { label: conf.label, variant: conf.variant }
	return { label: status, variant: 'outline' }
}

const KIND_LABEL: Record<string, string> = {
	payment_succeeded: 'Платёж получен',
	payment_failed: 'Платёж не прошёл',
	receipt_confirmed: 'Чек ОФД',
	receipt_failed: 'Ошибка чека',
	booking_confirmed: 'Бронь подтверждена',
	checkin_reminder: 'Напоминание о заезде',
	review_request: 'Просьба об отзыве',
}

/** Unknown kind → raw code (operator sees new backend value). */
export function notificationKindLabel(kind: string): string {
	return KIND_LABEL[kind] ?? kind
}
