import { addDays, todayIso } from '../../chessboard/lib/date-range.ts'

/**
 * Pure helpers for the ratePlan seeding mutation. Extracted so the
 * money-conversion + date-iteration logic is independently testable
 * without mocking TanStack Query / fetch.
 *
 * Money discipline (M4 lesson): ₽ arrives as `number` from the form,
 * converts to micros (10⁶ scale) using BigInt arithmetic. Number×1e6
 * would silently lose precision past ₽9_007_199 (2⁵³/10⁶ safe-int
 * threshold); BigInt avoids it. Caller passes the resulting string to
 * the bulk-upsert — backend Zod `amountSchema` accepts string-of-
 * bigint per wire convention.
 */

interface SeedRate {
	readonly date: string
	readonly amount: string // bigint serialized as decimal string
	readonly currency: 'RUB'
}

interface SeedAvailability {
	readonly date: string
	readonly allotment: number
}

/**
 * Convert rubles (as a non-negative integer number) to micros string.
 *
 * Invariants:
 *   - Input `rub >= 0` — negative prices rejected (server also rejects)
 *   - Input `rub` must be integer — decimal part throws (backend uses
 *     integer micros, not float)
 *   - Output is the decimal string of `rub * 1_000_000n`, ready for
 *     bulk-upsert payload
 */
export function rubToMicrosString(rub: number): string {
	if (!Number.isInteger(rub)) {
		throw new Error(`rubToMicrosString: expected integer rubles, got ${rub}`)
	}
	if (rub < 0) {
		throw new Error(`rubToMicrosString: expected non-negative rubles, got ${rub}`)
	}
	return (BigInt(rub) * 1_000_000n).toString()
}

/**
 * Build the 30-day forward seeding payload from today (UTC-anchored via
 * shared `todayIso` → `addDays`, not ad-hoc `new Date()`). Same day-
 * indexing as chessboard grid, so the dates we seed == the dates grid
 * displays.
 */
export function buildSeedPayload(args: { nightlyRub: number; allotment: number; days?: number }): {
	rates: SeedRate[]
	availability: SeedAvailability[]
} {
	const days = args.days ?? 30
	if (days < 1 || days > 365) {
		throw new Error(`buildSeedPayload: days must be 1..365, got ${days}`)
	}
	if (!Number.isInteger(args.allotment) || args.allotment < 0) {
		throw new Error(`buildSeedPayload: allotment must be non-negative integer`)
	}
	const amount = rubToMicrosString(args.nightlyRub)
	const start = todayIso()
	const rates: SeedRate[] = []
	const availability: SeedAvailability[] = []
	for (let i = 0; i < days; i++) {
		const date = addDays(start, i)
		rates.push({ date, amount, currency: 'RUB' })
		availability.push({ date, allotment: args.allotment })
	}
	return { rates, availability }
}
