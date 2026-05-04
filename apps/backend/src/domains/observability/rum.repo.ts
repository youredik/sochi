/**
 * In-memory RUM buffer with bounded ring-FIFO + drop-oldest semantics —
 * M9.widget.7 / A5.2 / D9.
 *
 * Per plan §2 D9: «Reservoir-sample edge buffer + 10k-metrics-per-write
 * batch». YC Cloud Monitoring API has a 10k-metrics-per-write hard limit
 * (docs 2026-03-24); buffering at the edge protects against burst RUM
 * traffic exceeding that.
 *
 * Policy: bounded queue of 5000. New metrics push to tail; on overflow we
 * drop the OLDEST entry (FIFO eviction) — preserves the most recent signal
 * which is most relevant for live-deploy regression detection.
 *
 * Sampling note: this is NOT statistical reservoir sampling (Vitter R) —
 * we don't need uniform random selection over an unbounded stream. The
 * 5000-cap is a memory bound; the YC exporter drains the full buffer on
 * every flush tick. Drop-oldest matches operational intent better than
 * uniform-random for «what's happening now».
 *
 * Thread-safety: Node.js single-threaded — no locks needed. If we ever
 * spawn worker_threads consuming this, wrap mutations in MutexQueue.
 *
 * Tests in `rum.routes.test.ts` (integration; route ↔ buffer) +
 * `yc-monitoring-exporter.test.ts` (drains buffer on flush).
 */

import type { RumMetric } from '@horeca/shared/rum'

export interface RumBufferOptions {
	readonly capacity: number
	/** Test seam — defaults to `Date.now`. Stamps `serverReceivedAt` on push. */
	readonly now?: () => number
}

/** Ring buffer entry — original metric + server-received wall-clock + IP-truncated source. */
export interface BufferedRumMetric extends RumMetric {
	readonly serverReceivedAt: number
	readonly truncatedIp: string
}

export class RumBuffer {
	#queue: BufferedRumMetric[] = []
	readonly #capacity: number
	readonly #now: () => number
	#droppedCount = 0

	constructor(opts: RumBufferOptions) {
		if (!Number.isInteger(opts.capacity) || opts.capacity < 1) {
			throw new RangeError(`RumBuffer: capacity must be a positive integer, got ${opts.capacity}`)
		}
		this.#capacity = opts.capacity
		this.#now = opts.now ?? Date.now
	}

	/**
	 * Push a metric to the tail. If buffer at capacity, drop the OLDEST
	 * entry (head) and increment droppedCount.
	 */
	push(metric: RumMetric, truncatedIp: string): void {
		const entry: BufferedRumMetric = {
			...metric,
			serverReceivedAt: this.#now(),
			truncatedIp,
		}
		if (this.#queue.length >= this.#capacity) {
			this.#queue.shift()
			this.#droppedCount++
		}
		this.#queue.push(entry)
	}

	/**
	 * Drain up to N metrics (FIFO). Returns the slice + clears it from
	 * internal state. Caller forwards to YC Monitoring exporter.
	 *
	 * @param limit max metrics to drain (default capacity)
	 */
	drain(limit?: number): readonly BufferedRumMetric[] {
		const cap = limit ?? this.#capacity
		if (cap <= 0) return []
		const taken = this.#queue.splice(0, cap)
		return taken
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

	/** Test-only — observe head without removing. */
	peek(): BufferedRumMetric | undefined {
		return this.#queue[0]
	}
}
