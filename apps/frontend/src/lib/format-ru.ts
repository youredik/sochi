/**
 * Russian-locale formatting helpers — money, dates, plurals.
 *
 * Per memory `project_m6_7_frontend_research.md` (3-round research synthesis,
 * 2026-04-25): canonical 2026 patterns + RU-locale gotchas.
 *
 * **Money:** kopecks (Int64 minor on backend) → "1 500,00 ₽" (NBSP groups,
 * comma decimal, trailing NBSP+₽). `currencyDisplay: 'symbol'` mandatory —
 * `'narrowSymbol'` THROWS on Safari iPad (WebKit 226297 still open 2026).
 * Two fraction digits ALWAYS (Russian accounting shows копейки even at .00).
 *
 * **Plurals:** RU has 4 forms (one/few/many/other). Lingui v6 `<Plural>` macro
 * is the canonical UI path; this module ships `Intl.PluralRules`-based helpers
 * for non-component code (toast callbacks, log messages, screen-reader text).
 *
 * **Dates:** `Intl.DateTimeFormat('ru-RU')` produces "25 апреля 2026 г., 17:30"
 * (long) or "25.04.2026, 17:30" (short). Always wrap in `<time dateTime={iso}>`
 * at render so screen-reader users can navigate by time landmark.
 *
 * **NBSP gotcha:** `Intl.NumberFormat('ru-RU')` uses `U+00A0` (NBSP) between
 * thousands and before `₽`. NEVER `.split(' ')` on formatted money — use
 * `.replace(/\s/g, '')` to match both NBSP and regular space.
 */
import { z } from 'zod'

/* ============================================================== money */

const RUB_FMT = new Intl.NumberFormat('ru-RU', {
	style: 'currency',
	currency: 'RUB',
	currencyDisplay: 'symbol', // NEVER narrowSymbol — iPad Safari throws
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
})

const RUB_PLURAL = new Intl.PluralRules('ru-RU')
const KOP_PLURAL = new Intl.PluralRules('ru-RU')

/**
 * RU `Intl.PluralRules` reachable keys ONLY: one/few/many/other.
 * 'zero' / 'two' / 'cardinal' nouns не используются Russian plural CLDR —
 * narrowing the type prevents dead-code mutations slipping past Stryker
 * (M6.5.1 mutation testing finding 2026-04-25).
 */
type RuPluralKey = 'one' | 'few' | 'many' | 'other'

const RUB_FORMS: Record<RuPluralKey, string> = {
	one: 'рубль',
	few: 'рубля',
	many: 'рублей',
	other: 'рубля',
}

const KOP_FORMS: Record<RuPluralKey, string> = {
	one: 'копейка',
	few: 'копейки',
	many: 'копеек',
	other: 'копейки',
}

/**
 * Format kopecks (Int64 minor) as Russian-locale currency string.
 *
 * Examples:
 *   formatMoney(0n)      → "0,00 ₽"
 *   formatMoney(150_000n)→ "1 500,00 ₽" (NBSP groups, comma decimal)
 *   formatMoney(-15000n) → "-150,00 ₽"  (minus sign per RU accounting,
 *                                         NEVER parentheses)
 *
 * Accepts bigint (canonical) or number (convenience for test fixtures).
 * Internal rendering through Number: kopecks values realistic for
 * HoReCa never exceed Number.MAX_SAFE_INTEGER (≈ 9e15 kopecks =
 * 9e13 RUB = ~50× Russian GDP).
 */
export function formatMoney(kopecks: bigint | number): string {
	const rub = Number(kopecks) / 100
	return RUB_FMT.format(rub)
}

/**
 * Render money for screen-reader expansion — full pronunciation with
 * Russian plural agreement.
 *
 * Examples:
 *   formatMoneyA11y(150_000n) → "1500 рублей 0 копеек"
 *   formatMoneyA11y(150_050n) → "1500 рублей 50 копеек"
 *   formatMoneyA11y(1_00n)    → "1 рубль 0 копеек"
 *   formatMoneyA11y(2_00n)    → "2 рубля 0 копеек"
 *
 * Pair with `<span aria-hidden>{formatMoney(k)}</span><span class="sr-only">
 * {formatMoneyA11y(k)}</span>` — visible-text + sr-only expanded form is the
 * canonical 2026 a11y pattern (NOT `aria-label` on a bare `<span>` — span has
 * no implicit role; ARIA spec ignores aria-label on it).
 */
export function formatMoneyA11y(kopecks: bigint): string {
	const n = Number(kopecks)
	const rubInt = Math.trunc(n / 100)
	const kopAbs = Math.abs(n % 100)
	const rubAbs = Math.abs(rubInt)
	const rubKey = RUB_PLURAL.select(rubAbs) as RuPluralKey
	const kopKey = KOP_PLURAL.select(kopAbs) as RuPluralKey
	return `${rubInt} ${RUB_FORMS[rubKey]} ${kopAbs} ${KOP_FORMS[kopKey]}`
}

/* =============================================================== dates */

const DATE_LONG_FMT = new Intl.DateTimeFormat('ru-RU', {
	dateStyle: 'long',
	timeStyle: 'short',
})
const DATE_SHORT_FMT = new Intl.DateTimeFormat('ru-RU', {
	dateStyle: 'short',
	timeStyle: 'short',
})
const RTF = new Intl.RelativeTimeFormat('ru-RU', { numeric: 'auto' })

/** "25 апреля 2026 г., 17:30" — for log/timeline/audit. */
export function formatDateLong(d: Date | string): string {
	return DATE_LONG_FMT.format(typeof d === 'string' ? new Date(d) : d)
}

/** "25.04.2026, 17:30" — compact for tables. */
export function formatDateShort(d: Date | string): string {
	return DATE_SHORT_FMT.format(typeof d === 'string' ? new Date(d) : d)
}

/**
 * "5 минут назад" / "вчера" / "через 2 часа".
 *
 * Picks the largest unit that fits the diff. `numeric: 'auto'` produces
 * narrative phrasing ("вчера" instead of "1 день назад") where the locale
 * has it.
 */
export function formatRelative(d: Date | string): string {
	const target = typeof d === 'string' ? new Date(d) : d
	const diffMs = target.getTime() - Date.now()
	const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
		['year', 31_536_000_000],
		['month', 2_628_000_000],
		['day', 86_400_000],
		['hour', 3_600_000],
		['minute', 60_000],
	]
	for (const [unit, ms] of units) {
		if (Math.abs(diffMs) >= ms) return RTF.format(Math.round(diffMs / ms), unit)
	}
	return RTF.format(0, 'minute')
}

/* ===================================================== Zod money transform */

/**
 * String → bigint kopecks transform for form input fields.
 *
 * Accepts user input like:
 *   "15"        → 1500n
 *   "15,50"     → 1550n  (RU comma decimal)
 *   "15.50"     → 1550n  (US/EN dot — also accepted, normalised)
 *   "1 500"     → 150_000n  (NBSP or regular space group separator)
 *   "1 500,00 ₽" → 150_000n (₽ symbol stripped)
 *
 * Rejects:
 *   negative
 *   non-finite
 *   parses-to-NaN
 *
 * Pair with `react-number-format`'s `<NumericFormat>` controlled input.
 */
export const moneyKopecksSchema = z
	.string()
	.transform((s) => s.replace(/[\s ₽]/g, '').replace(',', '.'))
	.transform((cleaned, ctx) => {
		const n = Number.parseFloat(cleaned)
		if (!Number.isFinite(n) || n < 0) {
			ctx.addIssue({ code: 'custom', message: 'Сумма должна быть положительным числом' })
			return z.NEVER
		}
		return BigInt(Math.round(n * 100))
	})
