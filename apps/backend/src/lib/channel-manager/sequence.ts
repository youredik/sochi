/**
 * Per-resource monotonic sequence number generator (Round 13 canon-impl alignment).
 *
 * Canon ref: `feedback_round_8_strict_sweep_canon_2026_05_25.md` +
 * `project_2026_grade_architecture_canon_2026_05_25.md` («Per-resource
 * monotonic sequence numbers»).
 *
 * Round 13 honest closure: prior implementation was process-global counter
 * shared across ALL resources. Canon claimed «per-resource» but reality was
 * single counter — Round 10 P1-A acknowledged. Round 13 closes the gap:
 *   - `nextSequenceNumber(key)` maintains `Map<key, {lastMicros, counter}>`
 *   - Each (tenantId, propertyId, channelId) resource gets its own monotonic
 *     stream → gap detection within a single process now distinguishes
 *     «gap from loss» from «another resource consumed numbers»
 *   - Legacy `nextSequenceNumber()` (no key) preserved для back-compat
 *     callers; routes к synthetic '__global__' key (same behavior as Round 10
 *     state, just explicitly named).
 *
 * What this helper IS for:
 *   - Per-resource monotonic clock with sub-microsecond tiebreaker counter
 *   - Time-aligned encoding: sequence ≈ (epoch_us << 12 | counter)
 *   - Cross-resource independence: resource A consuming N numbers does NOT
 *     advance resource B's counter
 *
 * What this helper is NOT:
 *   - Not cross-process safe (each Node/Bun worker has its own Map)
 *   - Not crash-recovery safe (Map resets on process restart)
 *   - Not load-bearing for true distributed gap detection — для production
 *     parity use YDB-generated sequence (`ROW_NUMBER() OVER PARTITION BY
 *     resource_key`) при persistence.
 */

const SUBSECOND_COUNTER_BITS = 12n // 4096 per microsecond — fits even high-frequency batches
const SUBSECOND_MASK = (1n << SUBSECOND_COUNTER_BITS) - 1n

/**
 * Per-resource state. Keyed by canonical resource tuple string
 * (`${tenantId}:${propertyId}:${channelId}`) OR `'__global__'` для legacy
 * no-key callers.
 */
interface ResourceState {
	lastMicroseconds: bigint
	counterWithinMicro: bigint
}

const resourceState = new Map<string, ResourceState>()
const LEGACY_KEY = '__global__'

function getOrInit(key: string): ResourceState {
	let s = resourceState.get(key)
	if (s === undefined) {
		s = { lastMicroseconds: 0n, counterWithinMicro: 0n }
		resourceState.set(key, s)
	}
	return s
}

/**
 * Compose canonical resource key from tuple. Stable lexicographic order
 * matters для cache-friendliness + canonicalization across callers.
 */
export function sequenceKey(input: {
	readonly tenantId: string
	readonly propertyId: string
	readonly channelId: string
}): string {
	return `${input.tenantId}:${input.propertyId}:${input.channelId}`
}

/**
 * Generate next sequence number for a resource. Guaranteed:
 *   - Strictly increasing within (process, resource-key) pair
 *   - Time-aligned: sequence ≈ (epoch_us << 12 | counter)
 *   - Idempotent in single-microsecond bursts: counter increments
 *   - Independent across resource keys (consuming N for resource A does NOT
 *     advance resource B's counter)
 *
 * @param key optional resource key — use `sequenceKey({tenantId, propertyId,
 *   channelId})` for canonical form. Omit for legacy global stream.
 */
export function nextSequenceNumber(key?: string): bigint {
	const stateKey = key ?? LEGACY_KEY
	const state = getOrInit(stateKey)
	const nowMicros = BigInt(Date.now()) * 1000n // ms→μs (Date.now is ms-resolution)
	if (nowMicros > state.lastMicroseconds) {
		state.lastMicroseconds = nowMicros
		state.counterWithinMicro = 0n
	} else {
		state.counterWithinMicro = (state.counterWithinMicro + 1n) & SUBSECOND_MASK
		if (state.counterWithinMicro === 0n) {
			// Counter overflow — bump microseconds artificially (rare; saturates after 4096 calls/ms)
			state.lastMicroseconds += 1n
		}
	}
	return (state.lastMicroseconds << SUBSECOND_COUNTER_BITS) | state.counterWithinMicro
}

/**
 * Derive sequence number from a fixed timestamp (для tests + replay).
 * Stateless — does NOT touch internal per-resource Map.
 */
export function sequenceFromTimestamp(timestampMs: number, counter: number = 0): bigint {
	return ((BigInt(timestampMs) * 1000n) << SUBSECOND_COUNTER_BITS) | BigInt(counter)
}

/**
 * Test-only: reset all per-resource state. NEVER call in production.
 */
export function __resetSequenceForTesting(): void {
	resourceState.clear()
}
