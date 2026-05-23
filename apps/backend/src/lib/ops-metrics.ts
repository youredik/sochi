/**
 * Backend ops-metrics buffer — domain-specific counters/histograms для backend
 * операций (passport_scan, payment, etc.) destined для YC Cloud Monitoring.
 *
 * Sprint C Day 3 2026-05-23: passport_scan нуждается в operational visibility
 * сверх Pino structured logs (which YC Cloud Logging уже aggregates). Metrics
 * give us:
 *   - p99 latency thresholds
 *   - error-rate SLO tracking
 *   - cost dashboards (Yandex Vision 0.71 ₽/call × N attempts)
 *
 * Design: in-memory FIFO buffer aligned с RumBuffer pattern в этом же dir.
 * Each metric event = {name, labels, value, ts}. Buffer drained by future
 * `yc-monitoring-exporter` (M11+ когда YC IAM credentials wired).
 *
 * **Until then**, buffer used by:
 *   - Tests: verify metric emission via `drain()` inspection
 *   - `/api/internal/ops-metrics` (future) для Prometheus-style scrape
 *
 * Thread-safety: Node.js single-thread — no locks. Worker threads would need
 * mutex wrap.
 */

/** Metric event — minimal canonical shape для YC DGAUGE/DCOUNTER mapping. */
export interface OpsMetricEvent {
	/** Dot-separated name canon, e.g. `passport_scan.attempts_total`. */
	readonly name: string
	/** Tags для group-by — keep low cardinality (no PII, no IDs). */
	readonly labels: Readonly<Record<string, string>>
	/** Numeric value — counter increment OR gauge sample. */
	readonly value: number
	/** Unix ms timestamp. */
	readonly ts: number
}

export interface OpsMetricsBufferOptions {
	readonly capacity: number
	/** Test seam — defaults к Date.now. */
	readonly now?: () => number
}

/**
 * Bounded ring buffer для ops-metrics. Drop-oldest semantics (preserve most-
 * recent signal — same canon как RumBuffer).
 */
export class OpsMetricsBuffer {
	#queue: OpsMetricEvent[] = []
	readonly #capacity: number
	readonly #now: () => number
	#droppedCount = 0

	constructor(opts: OpsMetricsBufferOptions) {
		if (!Number.isInteger(opts.capacity) || opts.capacity < 1) {
			throw new RangeError(
				`OpsMetricsBuffer: capacity must be a positive integer, got ${opts.capacity}`,
			)
		}
		this.#capacity = opts.capacity
		this.#now = opts.now ?? Date.now
	}

	/**
	 * Push a metric event. If buffer at capacity, drop the OLDEST entry (FIFO)
	 * and increment droppedCount. Defensive — copies labels to prevent caller
	 * mutation polluting buffered events.
	 */
	push(input: { name: string; labels: Record<string, string>; value: number }): void {
		const entry: OpsMetricEvent = {
			name: input.name,
			labels: Object.freeze({ ...input.labels }),
			value: input.value,
			ts: this.#now(),
		}
		if (this.#queue.length >= this.#capacity) {
			this.#queue.shift()
			this.#droppedCount++
		}
		this.#queue.push(entry)
	}

	/**
	 * Drain up to N events (FIFO). Returns slice + clears from internal state.
	 * Caller forwards к YC Monitoring exporter / Prometheus scrape.
	 */
	drain(limit?: number): readonly OpsMetricEvent[] {
		const cap = limit ?? this.#capacity
		if (cap <= 0) return []
		return this.#queue.splice(0, cap)
	}

	get size(): number {
		return this.#queue.length
	}

	get capacity(): number {
		return this.#capacity
	}

	get droppedCount(): number {
		return this.#droppedCount
	}

	/** Test-only: observe head без removal. */
	peek(): OpsMetricEvent | undefined {
		return this.#queue[0]
	}
}

/**
 * Singleton instance for app-wide ops-metric emission. Tests should NOT reuse
 * this — instantiate own buffer per test для isolation.
 *
 * Capacity 5000 = ~3min of passport scans @ 30/min × multiplier sites.
 */
export const opsMetricsBuffer = new OpsMetricsBuffer({ capacity: 5000 })

/**
 * Convenience helper — emit passport_scan metric. Wraps push() с canonical
 * name `passport_scan.{kind}_total`. Labels MUST be low-cardinality (outcome,
 * identityMethod, apiModel) — НЕ tenantId/guestId/imageHash.
 */
export function emitPassportScanMetric(input: {
	kind: 'attempts' | 'duration_ms' | 'cost_kopecks' | 'orphan_compensation_failed'
	outcome: string
	identityMethod: string
	apiModel: string
	rklStatus?: string
	value: number
	now?: () => number
}): void {
	const labels: Record<string, string> = {
		outcome: input.outcome,
		identityMethod: input.identityMethod,
		apiModel: input.apiModel,
	}
	if (input.rklStatus !== undefined) {
		labels.rklStatus = input.rklStatus
	}
	opsMetricsBuffer.push({
		name: `passport_scan.${input.kind}`,
		labels,
		value: input.value,
	})
}
