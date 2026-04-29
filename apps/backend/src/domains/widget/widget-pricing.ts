/**
 * Widget pricing — pure helpers (no I/O, no clock dependency unless explicit).
 *
 * All money values flow as `bigint` micros (× 10⁶ RUB) per system canon
 * (`apps/backend/src/db/ydb-helpers.ts` Money helpers + `project_ydb_specifics.md` #13).
 * Wire format converts to integer kopecks (1 RUB = 100 kopecks); frontend
 * formats RU.
 *
 * Per `plans/m9_widget_canonical.md` §M9.widget.2 + ЮKassa canon corrections
 * (`project_yookassa_canon_corrections.md`): Сочи tourism tax 2% NOT broken
 * out separately в чеке (one combined service line), но в widget-summary мы
 * отображаем breakdown для transparency перед оплатой.
 */

const MICROS_PER_KOPECK = 10_000n
const BPS_DENOM = 10_000n

/**
 * Sum nightly rates over a continuous range. Returns 0n on empty array.
 *
 * Caller is responsible для обеспечения `rates.length === nights` — service
 * layer enforces (no holes) и throws если rate отсутствует на дату внутри
 * диапазона.
 */
export function sumNightlyRates(amountsMicros: readonly bigint[]): bigint {
	let total = 0n
	for (const amt of amountsMicros) {
		if (amt < 0n) throw new Error(`Negative rate amount: ${amt}`)
		total += amt
	}
	return total
}

/**
 * Compute tourism tax (РФ Сочи 2% per Краснодарский край law) on subtotal.
 *
 * Formula: floor(subtotal × bps / 10_000). Floor rounding favors guest по
 * РФ-norm (round-down for tax inflows). bps = basis points (200 = 2.00%).
 * Bps must be ≥ 0 (тур.налог не отрицателен).
 */
export function computeTourismTaxMicros(subtotalMicros: bigint, taxRateBps: number): bigint {
	if (!Number.isInteger(taxRateBps)) throw new Error(`taxRateBps must be integer: ${taxRateBps}`)
	if (taxRateBps < 0) throw new Error(`taxRateBps must be non-negative: ${taxRateBps}`)
	if (subtotalMicros < 0n) throw new Error(`subtotalMicros negative: ${subtotalMicros}`)
	if (taxRateBps === 0) return 0n
	return (subtotalMicros * BigInt(taxRateBps)) / BPS_DENOM
}

export interface QuoteTotals {
	readonly subtotalMicros: bigint
	readonly tourismTaxMicros: bigint
	readonly totalMicros: bigint
	/** Wire-format kopecks для frontend. Truncates micros NOT consumed (sub-kopeck). */
	readonly subtotalKopecks: number
	readonly tourismTaxKopecks: number
	readonly totalKopecks: number
}

/**
 * Build a complete quote totals struct from nightly rate sum + tax bps.
 * Wire-format kopecks — floor truncation (1 кп ≥ 10_000 micros).
 */
export function buildQuote(amountsMicros: readonly bigint[], taxRateBps: number): QuoteTotals {
	const subtotalMicros = sumNightlyRates(amountsMicros)
	const tourismTaxMicros = computeTourismTaxMicros(subtotalMicros, taxRateBps)
	const totalMicros = subtotalMicros + tourismTaxMicros
	return {
		subtotalMicros,
		tourismTaxMicros,
		totalMicros,
		subtotalKopecks: micrsToKopecks(subtotalMicros),
		tourismTaxKopecks: micrsToKopecks(tourismTaxMicros),
		totalKopecks: micrsToKopecks(totalMicros),
	}
}

/**
 * Convert micros → kopecks (rounded down). Throws if exceeds `Number.MAX_SAFE_INTEGER`
 * after conversion (kopecks are wire-format JS-safe up to ~9×10¹⁵).
 */
export function micrsToKopecks(micros: bigint): number {
	if (micros < 0n) throw new Error(`micros negative: ${micros}`)
	const k = micros / MICROS_PER_KOPECK
	const n = Number(k)
	if (!Number.isSafeInteger(n)) {
		throw new Error(`kopecks ${k} exceeds Number.MAX_SAFE_INTEGER (micros=${micros})`)
	}
	return n
}

/**
 * Enumerate calendar days between checkIn (inclusive) and checkOut (exclusive)
 * as YYYY-MM-DD strings in UTC. Hotel night = check-in day; check-out day NOT
 * counted (industry convention).
 *
 * Validates: ISO format YYYY-MM-DD; checkIn < checkOut; no DST drift (UTC ops).
 */
export function enumerateNightDates(checkIn: string, checkOut: string): string[] {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn)) throw new Error(`checkIn invalid: ${checkIn}`)
	if (!/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) throw new Error(`checkOut invalid: ${checkOut}`)
	const inMs = Date.UTC(
		Number(checkIn.slice(0, 4)),
		Number(checkIn.slice(5, 7)) - 1,
		Number(checkIn.slice(8, 10)),
	)
	const outMs = Date.UTC(
		Number(checkOut.slice(0, 4)),
		Number(checkOut.slice(5, 7)) - 1,
		Number(checkOut.slice(8, 10)),
	)
	if (Number.isNaN(inMs) || Number.isNaN(outMs)) {
		throw new Error(`Invalid date construction: ${checkIn} → ${checkOut}`)
	}
	if (inMs >= outMs) {
		throw new Error(`checkIn must be < checkOut: ${checkIn} >= ${checkOut}`)
	}
	const oneDay = 86_400_000
	const out: string[] = []
	for (let t = inMs; t < outMs; t += oneDay) {
		const d = new Date(t)
		out.push(
			`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
				d.getUTCDate(),
			).padStart(2, '0')}`,
		)
	}
	return out
}

/**
 * Compute the deadline for free cancellation given check-in date + cancellation
 * window (hours). Returns ISO-8601 instant в property timezone-naive UTC anchor
 * (frontend re-renders в local TZ).
 *
 * Per ratePlan canon `0001_init.sql` §2.4: cancellationHours nullable → null
 * = non-refundable (no deadline).
 */
export function computeFreeCancelDeadline(
	checkInIsoDate: string,
	cancellationHours: number | null,
): string | null {
	if (cancellationHours === null) return null
	if (!Number.isInteger(cancellationHours) || cancellationHours < 0) {
		throw new Error(`cancellationHours must be non-negative integer: ${cancellationHours}`)
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(checkInIsoDate)) {
		throw new Error(`checkInIsoDate invalid: ${checkInIsoDate}`)
	}
	// Hotel check-in default 14:00 local. Tax-conservative: deadline computed
	// в UTC от 14:00 local, frontend convert per property TZ. Demo property
	// Europe/Moscow = UTC+3, поэтому 14:00 MSK = 11:00 UTC. Stored как UTC ISO.
	const ms = Date.UTC(
		Number(checkInIsoDate.slice(0, 4)),
		Number(checkInIsoDate.slice(5, 7)) - 1,
		Number(checkInIsoDate.slice(8, 10)),
		11, // Approximation: 14:00 Europe/Moscow = 11:00 UTC. Real TZ-conversion в UI layer.
		0,
		0,
		0,
	)
	const deadline = new Date(ms - cancellationHours * 3_600_000)
	return deadline.toISOString()
}
