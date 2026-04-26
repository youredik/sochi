/**
 * `formatMonthRu(yyyymm)` — `"2026-04"` → `"Апрель 2026"`.
 *
 * Tested in `format-month.test.ts` per memory `feedback_strict_tests.md`.
 *
 * Defensive against malformed input (decimal months, out-of-range, missing
 * dash) — falls back gracefully so a backend bug doesn't crash the report
 * page. Strict-mode invariants:
 *   - Empty / malformed input → returns input as-is (no throw, no crash).
 *   - Out-of-range month (00 / 13+) → returns "{numericMonth} {year}" without
 *     name (so the operator sees something is wrong, not a "Январь" lie).
 */

const RU_MONTH_NAMES = [
	'Январь',
	'Февраль',
	'Март',
	'Апрель',
	'Май',
	'Июнь',
	'Июль',
	'Август',
	'Сентябрь',
	'Октябрь',
	'Ноябрь',
	'Декабрь',
] as const

export function formatMonthRu(yyyymm: string): string {
	if (typeof yyyymm !== 'string' || !yyyymm.includes('-')) return yyyymm
	const [yearStr, monthStr] = yyyymm.split('-')
	if (!yearStr || !monthStr) return yyyymm
	const monthNum = Number(monthStr)
	if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
		return `${monthStr} ${yearStr}`.trim()
	}
	const name = RU_MONTH_NAMES[monthNum - 1]
	return `${name} ${yearStr}`
}
