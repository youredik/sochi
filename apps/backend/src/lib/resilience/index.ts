// =============================================================================
// Minimal resilience policies for outbound HTTP adapters
// =============================================================================
//
// Why we wrote our own (not Cockatiel / Opossum):
//
//   * Cockatiel 3.2.1 (last release 2024-07-22) — stale 21+ months on
//     2026-04-27. Per `feedback_aggressive_delegacy.md`: stale deps go
//     molniyenosno.
//   * Opossum 8.x (active) is fine but adds 50 KB + EventEmitter + CommonJS
//     interop quirks under ESM that we don't need.
//   * Our needs are narrow: timeout + bounded retry with exponential jitter
//     + circuit breaker. ~100 lines, no deps. Yandex Cloud only canon
//     loves this.
//
// Used by: YooKassa adapter, ЕПГУ adapter, Yandex Vision adapter, channel
// manager adapters (M8.B / M8.A / M8.C). Stub-provider doesn't need it
// (no real HTTP).
//
// Composition pattern (canonical 2026):
//
//   const policy = composePolicies(
//     timeoutPolicy(10_000),
//     retryPolicy({ attempts: 3, baseMs: 200, maxMs: 5_000 }),
//     circuitBreakerPolicy({ failureThreshold: 5, resetAfterMs: 60_000 }),
//   )
//   const result = await policy.execute(() => fetch(url, init))
//
// Order matters: outer-to-inner. The circuit breaker wraps everything (so
// open-circuit fails fast WITHOUT consuming retry budget). Retry wraps
// timeout (so each attempt has its own timeout, not a shared one). Timeout
// is innermost (wraps the actual call).
//
// =============================================================================

/**
 * Thrown when an operation exceeds its timeout window.
 * `name === 'TimeoutError'` for `instanceof` checks across module boundaries.
 */
export class TimeoutError extends Error {
	override readonly name = 'TimeoutError'
	readonly timeoutMs: number
	constructor(timeoutMs: number) {
		super(`Operation timed out after ${timeoutMs}ms`)
		this.timeoutMs = timeoutMs
	}
}

/**
 * Thrown when the circuit breaker is open (rejecting calls fast without
 * invoking the underlying operation). Signals «upstream is down, back off».
 */
export class CircuitOpenError extends Error {
	override readonly name = 'CircuitOpenError'
	readonly resetAt: Date
	constructor(resetAt: Date) {
		super(`Circuit is open until ${resetAt.toISOString()}`)
		this.resetAt = resetAt
	}
}

/**
 * Common policy interface — every policy can wrap an async operation and
 * return its result (or throw a typed error).
 */
export interface Policy {
	execute<T>(operation: () => Promise<T>): Promise<T>
}

// ---------------------------------------------------------------------------
// Timeout policy
// ---------------------------------------------------------------------------

/**
 * Wraps an operation in `Promise.race` against a timeout. If the timeout
 * fires first, throws {@link TimeoutError}. The original operation continues
 * running (we have no way to cancel a Promise) — caller is responsible for
 * passing AbortSignal-aware operations if cancellation matters (typical for
 * `fetch`, where you'd combine this with a per-call AbortController).
 *
 * @param timeoutMs strictly positive
 */
export function timeoutPolicy(timeoutMs: number): Policy {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new RangeError(`timeoutPolicy: timeoutMs must be > 0, got ${timeoutMs}`)
	}
	return {
		async execute<T>(op: () => Promise<T>): Promise<T> {
			let timer: ReturnType<typeof setTimeout> | undefined
			try {
				return await Promise.race([
					op(),
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs)
					}),
				])
			} finally {
				if (timer !== undefined) clearTimeout(timer)
			}
		},
	}
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

export interface RetryOptions {
	/** Total number of attempts (incl. first). 1 = no retry. Min 1. */
	readonly attempts: number
	/** Base delay before the FIRST retry (ms). Halved by jitter. */
	readonly baseMs: number
	/** Max delay between attempts (ms). Cap for exponential growth. */
	readonly maxMs: number
	/**
	 * Optional predicate — return `false` to abort retries (e.g. 4xx
	 * client errors that won't get better). Default: retry on every error.
	 */
	readonly shouldRetry?: (err: unknown, attemptNumber: number) => boolean
	/**
	 * Test seam for deterministic jitter. Default: Math.random.
	 * Returns a number in [0, 1).
	 */
	readonly random?: () => number
	/** Test seam for setTimeout. Default: global setTimeout. */
	readonly delay?: (ms: number) => Promise<void>
}

/**
 * Exponential backoff + decorrelated jitter. Per attempt N (0-indexed):
 *
 *   raw  = min(maxMs, baseMs * 2^N)
 *   wait = raw/2 + random() * raw/2     // jitter ∈ [raw/2, raw)
 *
 * On final attempt's failure, propagates the original error untouched
 * (NOT wrapped) — caller's error handling sees the real upstream error.
 */
export function retryPolicy(opts: RetryOptions): Policy {
	if (!Number.isInteger(opts.attempts) || opts.attempts < 1) {
		throw new RangeError(`retryPolicy: attempts must be a positive integer, got ${opts.attempts}`)
	}
	if (!Number.isFinite(opts.baseMs) || opts.baseMs < 0) {
		throw new RangeError(`retryPolicy: baseMs must be >= 0, got ${opts.baseMs}`)
	}
	if (!Number.isFinite(opts.maxMs) || opts.maxMs < opts.baseMs) {
		throw new RangeError(
			`retryPolicy: maxMs must be >= baseMs, got max=${opts.maxMs} base=${opts.baseMs}`,
		)
	}
	const random = opts.random ?? Math.random
	const delay =
		opts.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	const shouldRetry = opts.shouldRetry ?? (() => true)
	return {
		async execute<T>(op: () => Promise<T>): Promise<T> {
			let lastErr: unknown
			for (let attempt = 0; attempt < opts.attempts; attempt++) {
				try {
					return await op()
				} catch (err) {
					lastErr = err
					const isLast = attempt === opts.attempts - 1
					if (isLast) break
					if (!shouldRetry(err, attempt + 1)) break
					const raw = Math.min(opts.maxMs, opts.baseMs * 2 ** attempt)
					const wait = raw / 2 + random() * (raw / 2)
					await delay(wait)
				}
			}
			throw lastErr
		},
	}
}

// ---------------------------------------------------------------------------
// Circuit breaker policy
// ---------------------------------------------------------------------------

export interface CircuitBreakerOptions {
	/** Consecutive failures before tripping. Min 1. */
	readonly failureThreshold: number
	/** Cool-down (ms) after tripping. After this, circuit goes half-open. */
	readonly resetAfterMs: number
	/** Test seam for clock. Default: Date.now. */
	readonly now?: () => number
}

type BreakerState =
	| { kind: 'closed'; consecutiveFailures: number }
	| { kind: 'open'; openedAt: number }
	| { kind: 'half-open' }

/**
 * Three-state circuit breaker:
 *
 *   closed    — pass through. Increment failure counter on errors;
 *               after N consecutive failures → open.
 *   open      — reject with {@link CircuitOpenError} immediately,
 *               WITHOUT invoking the operation.
 *               After resetAfterMs → half-open.
 *   half-open — allow ONE probe. Success → closed (reset counter).
 *               Failure → open again (full cooldown).
 *
 * Concurrency note: this is NOT lock-free between concurrent `execute()` —
 * two parallel calls in half-open state could both probe. Acceptable for
 * our use case (rate-limited adapter calls inside our backend); if we
 * eventually need strict half-open serialization, wrap in a Mutex. Out of
 * scope for M8.0 prep.
 */
export function circuitBreakerPolicy(opts: CircuitBreakerOptions): Policy {
	if (!Number.isInteger(opts.failureThreshold) || opts.failureThreshold < 1) {
		throw new RangeError(
			`circuitBreakerPolicy: failureThreshold must be a positive integer, got ${opts.failureThreshold}`,
		)
	}
	if (!Number.isFinite(opts.resetAfterMs) || opts.resetAfterMs < 0) {
		throw new RangeError(
			`circuitBreakerPolicy: resetAfterMs must be >= 0, got ${opts.resetAfterMs}`,
		)
	}
	const now = opts.now ?? Date.now
	let state: BreakerState = { kind: 'closed', consecutiveFailures: 0 }
	return {
		async execute<T>(op: () => Promise<T>): Promise<T> {
			// Open → check cooldown
			if (state.kind === 'open') {
				const elapsed = now() - state.openedAt
				if (elapsed < opts.resetAfterMs) {
					throw new CircuitOpenError(new Date(state.openedAt + opts.resetAfterMs))
				}
				state = { kind: 'half-open' }
			}
			try {
				const result = await op()
				// Success → close & reset counter
				state = { kind: 'closed', consecutiveFailures: 0 }
				return result
			} catch (err) {
				if (state.kind === 'half-open') {
					// Half-open probe failed → re-open with full cooldown
					state = { kind: 'open', openedAt: now() }
				} else {
					// Closed → increment counter; trip if threshold reached
					const newCount = state.consecutiveFailures + 1
					if (newCount >= opts.failureThreshold) {
						state = { kind: 'open', openedAt: now() }
					} else {
						state = { kind: 'closed', consecutiveFailures: newCount }
					}
				}
				throw err
			}
		},
	}
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Compose policies outer-to-inner. Recommended order:
 *
 *   composePolicies(
 *     circuitBreakerPolicy(...),  // outermost — open-circuit fails fast
 *     retryPolicy(...),           // retry per attempt
 *     timeoutPolicy(...),         // innermost — bounds each call
 *   )
 *
 * @returns a Policy that applies all in order.
 */
export function composePolicies(...policies: readonly Policy[]): Policy {
	if (policies.length === 0) {
		return { execute: <T>(op: () => Promise<T>) => op() }
	}
	return {
		execute<T>(op: () => Promise<T>): Promise<T> {
			// Right-fold: innermost wraps the operation first.
			let wrapped: () => Promise<T> = op
			for (let i = policies.length - 1; i >= 0; i--) {
				const policy = policies[i]
				if (policy === undefined) continue
				const inner = wrapped
				wrapped = () => policy.execute(inner)
			}
			return wrapped()
		},
	}
}
