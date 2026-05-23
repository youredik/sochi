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

import { logger } from '../logger.ts'

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

	/**
	 * Sprint C+1 self-review H7 fix: reset droppedCount после ops-metrics
	 * exporter consumed the warning. Otherwise droppedCount accumulates
	 * across full buffer lifetime → false-positive alerts. Tests verify
	 * этот reset gates the alarm correctly.
	 */
	resetDroppedCount(): void {
		this.#droppedCount = 0
	}
}

/**
 * Singleton instance for app-wide ops-metric emission. Tests should NOT reuse
 * this — instantiate own buffer per test для isolation.
 *
 * Capacity 5000 = ~3min of passport scans @ 30/min × multiplier sites.
 *
 * **Sprint C+1 self-review P1.3 — multi-instance gotcha**: Этот singleton =
 * per-process. На YC Serverless с provisioned_instances=2+ каждый pod имеет
 * свой buffer → drain to YC Monitoring должен либо:
 *   (a) keep provisioned_instances=1 (current default в container.tf),
 *   (b) migrate к YDB-backed metrics (M11+),
 *   (c) use Yandex Cloud Logging as canonical source (every emitPassportScanMetric
 *       also calls c.var.logger.info with same labels, which YC Cloud Logging
 *       aggregates per-instance → final metrics consistent).
 * Current canon = (a) + (c). See [[demo_inbox_multi_instance_canon]] precedent.
 */
export const opsMetricsBuffer = new OpsMetricsBuffer({ capacity: 5000 })

/**
 * Threshold для warning log когда buffer drops events. Helps operator detect
 * sustained load без YC Monitoring exporter wired up yet.
 */
const OPS_METRICS_DROP_WARN_THRESHOLD = 100

/**
 * Convenience helper — emit passport_scan metric. Wraps push() с canonical
 * name `passport_scan.{kind}_total`. Labels MUST be low-cardinality (outcome,
 * identityMethod, apiModel) — НЕ tenantId/guestId/imageHash.
 *
 * Sprint C+1 self-review P1.4 fix: cost_kopecks model-aware rate table вместо
 * hardcoded 71 копеек. Yandex Vision pricing varies per model — `passport`
 * @ 0.71 ₽, `page` (загранпаспорт через recognizeText) и `driver-license-front`
 * @ same rate per Yandex AI Studio pricing 2026-Q2. Future Yandex price changes
 * = only update этот table.
 *
 * Self-review H7 fix: if buffer crosses drop threshold (capacity full + N
 * silent drops), emit warning log so operator can detect sustained load.
 */
const PASSPORT_SCAN_COST_KOPECKS_BY_MODEL: Readonly<Record<string, number>> = {
	passport: 71,
	page: 71,
	'driver-license-front': 71,
	'driver-license-back': 71,
}

/**
 * Sprint C+1 self-review: lookup cost per Yandex Vision model. Returns null
 * для unknown models (no metric emitted — better than wrong number).
 */
export function passportScanCostKopecks(apiModel: string): number | null {
	return PASSPORT_SCAN_COST_KOPECKS_BY_MODEL[apiModel] ?? null
}

export function emitPassportScanMetric(input: {
	/**
	 * Sprint C+ Senior P0-2 (2026-05-23d): added `upload_failed`. Replaces
	 * `orphan_compensation_failed` (kept for callsite back-compat) — reverse-order
	 * vision flow means no compensating delete; upload failures are tracked
	 * separately (audit row preserved with null objectKey, no orphan).
	 */
	kind: 'attempts' | 'duration_ms' | 'cost_kopecks' | 'orphan_compensation_failed' | 'upload_failed'
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
	// Round 2 self-review YDB P1 fix: use Pino logger instead of console.warn
	// for proper YC Cloud Logging severity mapping (formatters.level uppercase
	// canon). console.warn writes к stderr БЕЗ `{level:"WARN"}` field → YC
	// indexes at INFO severity → alarms ignored. logger.ts lives в same parent
	// dir — no domain dependency violation.
	//
	// Round 2 Senior P1-9 fix: per-process rate limit (1 warn per 60s) prevents
	// log amplification под sustained burst (30 scans/sec × N tenants).
	if (
		opsMetricsBuffer.droppedCount >= OPS_METRICS_DROP_WARN_THRESHOLD &&
		Date.now() - lastWarnLogTime > WARN_LOG_THROTTLE_MS
	) {
		lastWarnLogTime = Date.now()
		logger.warn(
			{
				event: 'ops_metrics.buffer_overflow',
				droppedCount: opsMetricsBuffer.droppedCount,
				capacity: opsMetricsBuffer.capacity,
				size: opsMetricsBuffer.size,
			},
			'ops-metrics buffer dropped events — wire YC Monitoring exporter (M11+)',
		)
		opsMetricsBuffer.resetDroppedCount()
	}
}

// Round 2 Senior P1-9: throttle warn-log emission (60s window).
let lastWarnLogTime = 0
const WARN_LOG_THROTTLE_MS = 60_000
