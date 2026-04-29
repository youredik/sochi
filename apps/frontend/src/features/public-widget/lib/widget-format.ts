/**
 * Pure RU formatting helpers — money + dates. NO React.
 * Vite Fast Refresh canon (correction #8 from M9.widget.1 done): utilities
 * stay в `lib/`, components в `components/` (никаких mixed exports).
 */

/**
 * Format kopecks (Int safe) → RU money string.
 *
 * Examples (RUB):
 *   formatRub(2_720_000) → "27 200 ₽"     (no fractional kopecks)
 *   formatRub(2_720_050) → "27 200,50 ₽"  (50 kopecks)
 *   formatRub(0)         → "0 ₽"
 *
 * Uses `Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' })`
 * — locale-aware NBSP separators, official RUB sign placement.
 */
export function formatRub(kopecks: number): string {
	if (!Number.isFinite(kopecks)) throw new Error(`kopecks not finite: ${kopecks}`)
	if (!Number.isInteger(kopecks)) throw new Error(`kopecks not integer: ${kopecks}`)
	const rubles = kopecks / 100
	const fractionDigits = kopecks % 100 === 0 ? 0 : 2
	return new Intl.NumberFormat('ru-RU', {
		style: 'currency',
		currency: 'RUB',
		minimumFractionDigits: fractionDigits,
		maximumFractionDigits: fractionDigits,
	}).format(rubles)
}

/**
 * Format a date range in human-readable RU form.
 * `formatDateRange('2026-06-01', '2026-06-06')` → "1–6 июня 2026"
 * Cross-month/year preserved: "30 июня — 3 июля 2026", "30 дек. 2026 — 3 янв. 2027"
 */
export function formatDateRange(checkInIso: string, checkOutIso: string): string {
	const inDate = parseIsoDate(checkInIso)
	const outDate = parseIsoDate(checkOutIso)
	const sameYear = inDate.getUTCFullYear() === outDate.getUTCFullYear()
	const sameMonth = sameYear && inDate.getUTCMonth() === outDate.getUTCMonth()

	if (sameMonth) {
		const inDay = inDate.getUTCDate()
		const outDay = outDate.getUTCDate()
		const monthGenitive = MONTHS_GENITIVE[inDate.getUTCMonth()]
		return `${inDay}–${outDay} ${monthGenitive} ${inDate.getUTCFullYear()}`
	}
	const inFmt = `${inDate.getUTCDate()} ${MONTHS_GENITIVE[inDate.getUTCMonth()]}`
	const outFmt = `${outDate.getUTCDate()} ${MONTHS_GENITIVE[outDate.getUTCMonth()]}`
	if (sameYear) return `${inFmt} — ${outFmt} ${outDate.getUTCFullYear()}`
	return `${inFmt} ${inDate.getUTCFullYear()} — ${outFmt} ${outDate.getUTCFullYear()}`
}

/**
 * Format a UTC instant (free-cancel deadline) as a RU short string в Europe/Moscow TZ.
 * `formatMoscowDateTime('2026-05-28T11:00:00Z')` → "до 28 мая, 14:00 (МСК)"
 *
 * Property-time canon: free cancel deadline computed на backend as UTC anchor
 * (assuming 14:00 MSK check-in default — see widget-pricing.ts). Frontend
 * re-renders в Europe/Moscow для anonymous user clarity. Real per-property TZ
 * implementation deferred к М9.widget.5 (booking confirmation localizes).
 */
export function formatMoscowDateTime(isoUtc: string): string {
	const d = new Date(isoUtc)
	if (Number.isNaN(d.getTime())) throw new Error(`invalid ISO: ${isoUtc}`)
	const fmt = new Intl.DateTimeFormat('ru-RU', {
		day: 'numeric',
		month: 'long',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
		timeZone: 'Europe/Moscow',
	})
	const parts = fmt.formatToParts(d)
	const get = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((p) => p.type === type)?.value ?? ''
	return `${get('day')} ${get('month')}, ${get('hour')}:${get('minute')} (МСК)`
}

/**
 * Format meal plan для UI labels.
 */
export function formatMeals(
	meals: 'none' | 'breakfast' | 'halfBoard' | 'fullBoard' | null,
): string | null {
	switch (meals) {
		case 'breakfast':
			return 'Завтрак включён'
		case 'halfBoard':
			return 'Полупансион'
		case 'fullBoard':
			return 'Полный пансион'
		case 'none':
		case null:
			return null
		default: {
			const _exhaustive: never = meals
			return null
		}
	}
}

const MONTHS_GENITIVE = [
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

function parseIsoDate(iso: string): Date {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`expected YYYY-MM-DD, got: ${iso}`)
	return new Date(`${iso}T00:00:00Z`)
}
