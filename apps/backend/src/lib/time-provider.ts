/**
 * TimeProvider — injectable clock for service-layer time operations.
 *
 * Canon per Stripe Test Clocks (2026 SDK), Apaleo «booking context clock»,
 * and DDD «hexagonal-port для time». Production code reads `clock.now()`
 * вместо `new Date()` — lets seed scripts pin к deterministic instants и
 * tests advance time без global mocks.
 *
 * **Why not just `new Date()` everywhere**:
 *   - Seed determinism: re-running seed should produce identical state.
 *     Pre-injection seed used wall-clock now() для confirmedAt/checkedInAt,
 *     so bookings drifted minute-to-minute even с identical input plan.
 *   - Test determinism: state-transition assertions need predictable ts
 *     (e.g. «checkOut at canonical now() + nightsCount * 1d»).
 *   - Future-clock simulation: revenue / nightly-audit / TTL test scenarios
 *     can advance days without `vi.useFakeTimers`-style globals.
 *
 * **Scope** — booking domain service-boundary clock. NOT:
 *   - `createdAt` / `updatedAt` at the DB-write level (audit truth = wall
 *     clock; CDC timestamps from real now).
 *   - CDC consumers — these run async, their own real-time projection.
 *   - HTTP layer (request ts), logger (log ts) — wall-clock canon.
 *
 * Production code MUST use `realTimeProvider`. Frozen variants exist only
 * for seed scripts + tests.
 */

/** Read-only clock used by domain services. */
export interface TimeProvider {
	/** Current «now» according to this clock. Always a fresh Date instance. */
	now(): Date
}

/** Production clock — delegates к `new Date()` per call. */
export const realTimeProvider: TimeProvider = {
	now: () => new Date(),
}

/**
 * Test/seed clock with explicit «now» + advance API.
 * Mutates internally; safe для sequential single-flight use (NOT thread-
 * safe but JS is single-threaded per agent).
 */
export interface MutableTimeProvider extends TimeProvider {
	/** Move clock forward by N milliseconds. Negative values rewind. */
	advance(ms: number): void
	/** Pin clock к specific instant. */
	setNow(at: Date | string): void
}

/**
 * Build a deterministic clock anchored at the given instant. Subsequent
 * calls to `now()` return THAT instant (cloned) until `advance()` or
 * `setNow()` is called.
 *
 * Accepts:
 *   - `Date` instance — used as-is (cloned defensively per .now())
 *   - ISO string — parsed via `new Date(string)`
 *
 * Example (seed):
 *   const clock = frozenTimeProvider('2026-05-18T00:00:00Z')
 *   const factory = createBookingFactory(..., clock)
 *   // Every booking created has confirmedAt = 2026-05-18T00:00:00Z
 *
 * Example (test):
 *   const clock = frozenTimeProvider(today)
 *   const booking = await service.create(...)
 *   clock.advance(24 * 60 * 60 * 1000)  // +1 day
 *   await service.checkIn(...)
 *   // checkedInAt = today + 1 day
 */
export function frozenTimeProvider(at: Date | string): MutableTimeProvider {
	let fixed = typeof at === 'string' ? new Date(at) : new Date(at)
	if (Number.isNaN(fixed.getTime())) {
		throw new Error(`frozenTimeProvider: invalid date input ${JSON.stringify(at)}`)
	}
	return {
		now: () => new Date(fixed),
		advance: (ms) => {
			fixed = new Date(fixed.getTime() + ms)
		},
		setNow: (next) => {
			const nextDate = typeof next === 'string' ? new Date(next) : new Date(next)
			if (Number.isNaN(nextDate.getTime())) {
				throw new Error(`frozenTimeProvider.setNow: invalid date input ${JSON.stringify(next)}`)
			}
			fixed = nextDate
		},
	}
}
