/**
 * Per-resource monotonic sequence number generator (Round 8 canon).
 *
 * Canon ref: `feedback_round_8_strict_sweep_canon_2026_05_25.md` +
 * `project_2026_grade_architecture_canon_2026_05_25.md` —
 * наш architectural leapfrog vs Apaleo/Mews/Cloudbeds/Hostaway:
 * each per-resource update emits strictly-increasing sequence so
 * consumers detect gaps + drop out-of-order updates.
 *
 * Implementation: epoch-microseconds + sub-microsecond tiebreaker counter,
 * monotonic per process. NOT cross-process safe — production code should
 * use YDB-generated sequence (e.g. column ROW_NUMBER OVER PARTITION) for
 * cross-replica correctness. Mocks + single-process flows use this helper.
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
