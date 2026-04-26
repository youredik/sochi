/**
 * RU labels for booking status + channel codes — pure mapping helpers.
 *
 * **Why pure module**: enum coverage is mandatory per memory
 * `feedback_pre_done_audit.md`. If backend adds a new status (e.g.
 * `pending`/`drafted`), unknown-key fallback returns the raw code so
 * the UI surfaces the new value instead of silently misclassifying
 * (anti-pattern: "show 'Подтверждена' for any unknown" hides bugs).
 *
 * Tested in `booking-labels.test.ts`.
 */

export type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive'

export interface StatusBadgeConf {
	label: string
	variant: BadgeVariant
}

const STATUS_LABEL: Record<string, StatusBadgeConf> = {
	confirmed: { label: 'Подтверждена', variant: 'outline' },
	in_house: { label: 'Заселился', variant: 'default' },
	checked_out: { label: 'Выехал', variant: 'secondary' },
	cancelled: { label: 'Отменена', variant: 'destructive' },
	no_show: { label: 'Не явился', variant: 'destructive' },
}

/**
 * Возвращает RU-label + Badge variant для booking.status. Unknown enum
 * value падает в neutral fallback (raw code + 'outline'), который видно
 * оператору — НЕ silent misclassification.
 *
 * Returns a FRESH object on every call — no shared mutable state, so
 * downstream consumers can mutate without poisoning the config.
 */
export function statusBadgeConf(status: string): StatusBadgeConf {
	const conf = STATUS_LABEL[status]
	if (conf) return { label: conf.label, variant: conf.variant }
	return { label: status, variant: 'outline' }
}

const CHANNEL_LABEL: Record<string, string> = {
	direct: 'Прямая',
	walkIn: 'Заходом',
	yandexTravel: 'Яндекс.Путешествия',
	ostrovok: 'Островок',
	travelLine: 'TravelLine',
	bnovo: 'Bnovo',
	bookingCom: 'Booking.com',
	expedia: 'Expedia',
	airbnb: 'Airbnb',
}

/** Возвращает RU-label для booking.channelCode. Unknown → raw code. */
export function channelLabel(code: string): string {
	return CHANNEL_LABEL[code] ?? code
}
