/**
 * G10 (2026-05-16) — pure-fn helpers для mobile-list view per R1+R2 canon
 * (Hostaway group-by-date pattern). Property-testable per
 * `[[fastcheck-gotchas]]` canon — keep ALL date logic pure.
 */

/**
 * Minimal booking shape that mobile-list grouping cares about. Generic-
 * compatible — full `Booking` shape extends this и widens through helper.
 */
export interface MobileListBooking {
	id: string
	checkIn: string // YYYY-MM-DD
	checkOut: string // YYYY-MM-DD
	status: string
	roomTypeId: string
}

export interface MobileListGroup<T extends MobileListBooking = MobileListBooking> {
	/** YYYY-MM-DD canonical key (sort order = group order) */
	dateKey: string
	bookings: T[]
}

/**
 * Group bookings по checkIn date. Sort groups ASC; sort within-group by
 * id ASC (deterministic — property-test friendly per
 * `[[interval-partition-greedy-canon]]` pattern).
 *
 * Generic к accept any shape extending MobileListBooking (e.g. full
 * GridBooking с guestSnapshot / channelCode / registrationStatus).
 *
 * Returns empty array for empty input.
 */
export function groupBookingsByCheckIn<T extends MobileListBooking>(
	bookings: T[],
): MobileListGroup<T>[] {
	const map = new Map<string, T[]>()
	for (const b of bookings) {
		const arr = map.get(b.checkIn)
		if (arr) {
			arr.push(b)
		} else {
			map.set(b.checkIn, [b])
		}
	}
	const groups: MobileListGroup<T>[] = []
	for (const [dateKey, list] of map) {
		groups.push({
			dateKey,
			bookings: list.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
		})
	}
	groups.sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0))
	return groups
}

/**
 * Filter bookings by status (multi-select). Empty `selected` set → no filter
 * (returns all). Per Hostaway 2026 mobile filter canon.
 */
export function filterByStatus<T extends Pick<MobileListBooking, 'status'>>(
	bookings: T[],
	selected: ReadonlySet<string>,
): T[] {
	if (selected.size === 0) return bookings
	return bookings.filter((b) => selected.has(b.status))
}

/**
 * Filter bookings by search text. Matches against `searchableText`
 * (passed by caller — caller builds it from guest mask + booking# к avoid
 * leaking guest firstName via search index per 152-ФЗ canon).
 */
export function filterBySearch<T>(
	bookings: T[],
	searchableTextOf: (b: T) => string,
	queryText: string,
): T[] {
	const q = queryText.trim().toLowerCase()
	if (!q) return bookings
	return bookings.filter((b) => searchableTextOf(b).toLowerCase().includes(q))
}

/**
 * Format date key (YYYY-MM-DD) as a human-readable RU group header.
 *   today → «Сегодня»
 *   today+1 → «Завтра»
 *   otherwise → «15 мая, четверг» (Cloudbeds canon)
 */
const RU_MONTHS = [
	'января',
	'февраля',
	'марта',
	'апреля',
	'мая',
	'июня',
	'июля',
	'августа',
	'сентября',
	'октября',
	'ноября',
	'декабря',
]
const RU_WEEKDAYS = [
	'воскресенье',
	'понедельник',
	'вторник',
	'среда',
	'четверг',
	'пятница',
	'суббота',
]

export function formatMobileGroupHeader(dateKey: string, todayKey: string): string {
	if (dateKey === todayKey) return 'Сегодня'
	const today = new Date(`${todayKey}T12:00:00Z`)
	const date = new Date(`${dateKey}T12:00:00Z`)
	const diffDays = Math.round((date.getTime() - today.getTime()) / 86_400_000)
	if (diffDays === 1) return 'Завтра'
	if (diffDays === -1) return 'Вчера'
	const day = date.getUTCDate()
	const month = RU_MONTHS[date.getUTCMonth()] ?? '?'
	const weekday = RU_WEEKDAYS[date.getUTCDay()] ?? '?'
	return `${day} ${month}, ${weekday}`
}

/** Pluralization helper для "N ночей" канон (1 ночь / 2 ночи / 5 ночей). */
export function pluralNights(n: number): string {
	const abs = Math.abs(n)
	const lastTwo = abs % 100
	if (lastTwo >= 11 && lastTwo <= 14) return 'ночей'
	const last = abs % 10
	if (last === 1) return 'ночь'
	if (last >= 2 && last <= 4) return 'ночи'
	return 'ночей'
}

/** Compute nights count from check-in/check-out date keys. */
export function nightsBetween(checkIn: string, checkOut: string): number {
	const ci = new Date(`${checkIn}T00:00:00Z`).getTime()
	const co = new Date(`${checkOut}T00:00:00Z`).getTime()
	const diff = Math.round((co - ci) / 86_400_000)
	return diff > 0 ? diff : 0
}
