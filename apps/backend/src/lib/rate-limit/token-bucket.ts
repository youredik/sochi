/**
 * In-process token bucket — client-side rate limiter для upstream API calls.
 *
 * Sprint C+ Round 6 2026-05-24 (Performance scale architect P1):
 *   YC Vision sync API quota = 1 RPS per folder. Check-in peak в Сочи (16:00-
 *   22:00) compresses 60% daily traffic к 6h window → bursts 5-10 RPS easily.
 *   Без client-side bucket, every burst hits 429 + cockatiel retry storm =
 *   amplification (each app retry × API 429 retry-after pause × N concurrent
 *   requests = thundering herd). Token bucket eliminates 429 at the SDK seam.
 *
 * Algorithm: forward-moving `nextAvailable` timestamp с N×interval slack для
 * allowing burst capacity. Implicit fairness — concurrent callers receive
 * deterministic execution order по acquire() invocation order. Simpler than
 * leaky-bucket counter (no balance state to drift) и produces same shape.
 *
 * AbortSignal-aware — caller cancellation (e.g. cockatiel timeout policy)
 * propagates без leaving stale setTimeout handles.
 *
 * Storage: single-process in-memory. Multi-instance YC Serverless Container:
 *   - Provisioned=1 (demo + small-scale prod): single bucket = canonical
 *   - Provisioned>1: per-instance bucket → effective RPS multiplied by N
 *     replicas. Acceptable upstream-side trade-off vs distributed Redis
 *     overhead; YC quota tolerates 2-3× burst для short windows.
 */

export interface TokenBucketOptions {
	/** Refill interval (ms). For 1 RPS: 1000. For 10 RPS: 100. */
	readonly refillIntervalMs: number
	/**
	 * Maximum burst — admits this many calls immediately, then steady at
	 * `refillIntervalMs`. Use `1` for strict no-burst rate limiting.
	 */
	readonly burstCapacity: number
}

export interface TokenBucket {
	/**
	 * Block until a token is available. Throws `AbortError` if signal aborts
	 * during wait. Does NOT throw на acquire when no signal — caller is queued.
	 */
	readonly acquire: (signal?: AbortSignal) => Promise<void>
	/** Test-only — current `nextAvailable` watermark in ms epoch. */
	readonly __nextAvailableMs: () => number
}

export function createTokenBucket(opts: TokenBucketOptions): TokenBucket {
	if (opts.refillIntervalMs <= 0) {
		throw new Error('refillIntervalMs must be > 0')
	}
	if (opts.burstCapacity < 1) {
		throw new Error('burstCapacity must be >= 1')
	}

	let nextAvailableMs = 0
	const burstSlackMs = opts.refillIntervalMs * (opts.burstCapacity - 1)

	const acquire = async (signal?: AbortSignal): Promise<void> => {
		if (signal?.aborted) {
			throw new DOMException('Aborted before token-bucket acquire', 'AbortError')
		}
		const now = Date.now()
		// Allow nextAvailable to be up to burstSlackMs behind `now` — каждый
		// such gap = 1 token of burst capacity. After consuming, advance
		// nextAvailable so next acquire respects steady refill rate.
		const earliest = Math.max(now - burstSlackMs, nextAvailableMs)
		nextAvailableMs = earliest + opts.refillIntervalMs
		const waitMs = earliest - now
		if (waitMs <= 0) {
			return
		}
		await new Promise<void>((resolve, reject) => {
			const t = setTimeout(resolve, waitMs)
			if (signal) {
				signal.addEventListener(
					'abort',
					() => {
						clearTimeout(t)
						reject(new DOMException('Aborted during token-bucket wait', 'AbortError'))
					},
					{ once: true },
				)
			}
		})
	}

	return {
		acquire,
		__nextAvailableMs: () => nextAvailableMs,
	}
}
