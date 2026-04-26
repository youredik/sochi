/**
 * Pure helpers for tax-report period defaults — RU fiscal-quarter math.
 *
 * Tested in `quarter-defaults.test.ts` per memory `feedback_strict_tests.md`.
 *
 * RU fiscal calendar (НК РФ ст. 285):
 *   - Q1 = янв–мар, Q2 = апр–июн, Q3 = июл–сен, Q4 = окт–дек.
 *   - Tourism-tax declaration deadline = 25-е число месяца, следующего за
 *     кварталом (НК РФ ст. 418.7). Платёж = 28-е.
 *
 * Default behaviour:
 *   - Showing report for the **current quarter** (in-progress) is the most
 *     useful view for an operator monitoring liability mid-period.
 *   - Past quarters остаются доступными через filter (период не блокируется).
 */

export type Quarter = 1 | 2 | 3 | 4

export interface YearQuarter {
	year: number
	quarter: Quarter
}

/** Return the calendar quarter (1..4) containing `month` (1..12). */
export function quarterOfMonth(month: number): Quarter {
	if (month < 1 || month > 12) {
		throw new RangeError(`quarterOfMonth: month must be 1..12, got ${month}`)
	}
	if (month <= 3) return 1
	if (month <= 6) return 2
	if (month <= 9) return 3
	return 4
}

/** First day of the given (year, quarter) as ISO YYYY-MM-DD. */
export function quarterStart({ year, quarter }: YearQuarter): string {
	const month = (quarter - 1) * 3 + 1
	return `${year}-${String(month).padStart(2, '0')}-01`
}

/** Last day of the given (year, quarter) as ISO YYYY-MM-DD. */
export function quarterEnd({ year, quarter }: YearQuarter): string {
	const lastMonth = quarter * 3 // 3, 6, 9, 12
	// JS `new Date(year, monthIndex+1, 0)` → last day of monthIndex.
	const d = new Date(Date.UTC(year, lastMonth, 0))
	const yyyy = d.getUTCFullYear()
	const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
	const dd = String(d.getUTCDate()).padStart(2, '0')
	return `${yyyy}-${mm}-${dd}`
}

/** YearQuarter containing today (UTC). */
export function currentYearQuarter(now: Date = new Date()): YearQuarter {
	return {
		year: now.getUTCFullYear(),
		quarter: quarterOfMonth(now.getUTCMonth() + 1),
	}
}

/** [from, to] для текущего квартала (UTC). */
export function defaultPeriod(now: Date = new Date()): { from: string; to: string } {
	const yq = currentYearQuarter(now)
	return { from: quarterStart(yq), to: quarterEnd(yq) }
}

/** Human-readable label "I квартал 2026" / "IV квартал 2025". */
export function formatQuarterLabel({ year, quarter }: YearQuarter): string {
	const roman = ['I', 'II', 'III', 'IV'][quarter - 1]
	return `${roman} квартал ${year}`
}

/**
 * Текущий квартал + N-1 предыдущих, в порядке от most-recent к most-distant.
 * Wrap-around корректно пересекает границу года (Q1 → Q4 предыдущего года).
 *
 * Used for "период" select preset list — операторы редко смотрят отчёты
 * старше 4 кварталов, и выбор всегда содержит текущий + три предыдущих.
 */
export function lastNQuarters(now: Date, n: number): YearQuarter[] {
	if (!Number.isInteger(n) || n < 1) {
		throw new RangeError(`lastNQuarters: n must be a positive integer, got ${n}`)
	}
	const cur = currentYearQuarter(now)
	const out: YearQuarter[] = []
	let year = cur.year
	let qNum: number = cur.quarter
	for (let i = 0; i < n; i++) {
		out.push({ year, quarter: qNum as Quarter })
		qNum -= 1
		if (qNum === 0) {
			qNum = 4
			year -= 1
		}
	}
	return out
}
