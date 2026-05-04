/**
 * Constant-tail-latency helper for slug-enumeration timing oracle defense
 * (M9.widget.6 / А4.3 D27, R2 F2).
 *
 * Per R2 Apr 2026 finding:
 *   * D11 rate-limit (429 на slug-probe) bounds enumeration RATE not SIGNAL.
 *   * YDB `property` lookup ~5-15 ms vs short-circuit 404 ~0.5 ms.
 *   * Statistically distinguishable after ~200 trials at 30 req/min — well
 *     within attacker's enumeration budget.
 *
 * Canon defense: always pay the worst-case cost. `Promise.allSettled` with
 * a fixed-floor delay → response wall-clock is ≥ floor regardless of
 * lookup hit/miss. Same pattern as `apps/backend/src/domains/widget/
 * booking-find.routes.ts` for the magic-link find-by-ref-email path.
 *
 * Reference:
 *   * Cloudflare Workers timing-attack canon (developers.cloudflare.com/
 *     workers/examples/protect-against-timing-attacks)
 *   * Laravel `timebox` 2025 Q4 helper (canonical PHP-side mirror).
 */

/**
 * Run `lookup` and resolve no sooner than `floorMs`. Returns whatever the
 * lookup resolves to (or rejects with whatever it rejects).
 *
 * @param lookup — DB query OR existence check that races with the floor
 * @param floorMs — minimum wall-clock latency (default 15 — covers the
 *   ~5-15ms YDB query window with ~3ms slack for jitter)
 */
export async function constantTailLatency<T>(lookup: () => Promise<T>, floorMs = 15): Promise<T> {
	const floor = new Promise<void>((resolve) => {
		setTimeout(resolve, floorMs)
	})
	const [lookupResult] = await Promise.allSettled([lookup(), floor])
	if (lookupResult.status === 'fulfilled') return lookupResult.value
	throw lookupResult.reason
}
