/**
 * Process-global monotonic sequence number generator (Round 8 canon).
 *
 * Canon ref: `feedback_round_8_strict_sweep_canon_2026_05_25.md` +
 * `project_2026_grade_architecture_canon_2026_05_25.md`.
 *
 * **Round 10 P1-A honest correction**: previous docstring claimed
 * «per-resource monotonic», but implementation uses single process-global
 * counter shared across ALL resources (channel mocks + bookings + ARI etc.).
 * Therefore «gap detection» works ONLY for cross-process replay safety —
 * within a single process you cannot tell apart «gap from loss» vs «gap from
 * another resource consuming numbers». Documentation now matches behavior.
 *
 * Real per-resource gap detection requires either:
 *   - YDB-generated sequence per partition (production canon — column
 *     `ROW_NUMBER() OVER PARTITION BY resource_key`), or
 *   - Threading a `key: string` parameter and maintaining `Map<key, bigint>`
 *     state (Phase-2 candidate if mock-level gap detection becomes needed).
 *
 * What this helper IS for:
 *   - Process-monotonic clock with sub-microsecond tiebreaker counter
 *   - Time-aligned encoding: sequence ≈ (epoch_us << 12 | counter)
 *   - Single-process tests where "increasing number that survives same-ms
 *     bursts" is the only requirement
 *
 * What this helper is NOT:
 *   - Not cross-process safe (each Node/Bun worker has its own counter)
 *   - Not per-resource (does not distinguish resources internally)
 *   - Not crash-recovery safe (counter resets to 0 on process restart)
 */

const SUBSECOND_COUNTER_BITS = 12n // 4096 per microsecond — fits even high-frequency batches
const SUBSECOND_MASK = (1n << SUBSECOND_COUNTER_BITS) - 1n

let lastMicroseconds = 0n
let counterWithinMicro = 0n

/**
 * Generate next sequence number. Guaranteed:
 *   - Strictly increasing within process
 *   - Time-aligned: sequence ≈ (epoch_us << 12 | counter)
 *   - Idempotent in single-microsecond bursts: counter increments
 *
 * @returns bigint sequence number
 */
export function nextSequenceNumber(): bigint {
	const nowMicros = BigInt(Date.now()) * 1000n // ms→μs (Date.now is ms-resolution)
	if (nowMicros > lastMicroseconds) {
		lastMicroseconds = nowMicros
		counterWithinMicro = 0n
	} else {
		counterWithinMicro = (counterWithinMicro + 1n) & SUBSECOND_MASK
		if (counterWithinMicro === 0n) {
			// Counter overflow — bump microseconds artificially (rare; saturates after 4096 calls/ms)
			lastMicroseconds += 1n
		}
	}
	return (lastMicroseconds << SUBSECOND_COUNTER_BITS) | counterWithinMicro
}

/**
 * Derive sequence number from a fixed timestamp (for tests + replay).
 * Same monotonic guarantee within a single (timestampMicros, counter) pair.
 */
export function sequenceFromTimestamp(timestampMs: number, counter: number = 0): bigint {
	return ((BigInt(timestampMs) * 1000n) << SUBSECOND_COUNTER_BITS) | BigInt(counter)
}

/**
 * Test-only: reset internal monotonic state. NEVER call in production.
 */
export function __resetSequenceForTesting(): void {
	lastMicroseconds = 0n
	counterWithinMicro = 0n
}
