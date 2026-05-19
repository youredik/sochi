/**
 * Readiness probe evaluator (B7 info-leak + B11 hardening, 2026-05-19).
 *
 * Pure-function variant of the `/health/ready` route logic — extracted so
 * info-leak shape regressions break в fast unit tests, not в production ALB
 * log forwarding incidents.
 *
 * Info-leak canon (OWASP API3:2023 Excessive Data Exposure):
 *   - Public probe body MUST contain only `{name, ok}` per check + `status` +
 *     `time`. NEVER include `error: String(err)` (YDB stack traces, exception
 *     messages), NEVER `offenderNames` (adapter inventory enumeration), NEVER
 *     internal topology hints.
 *   - Operator detail (YDB exception, adapter names) flows к structured
 *     `logger.error` ONLY.
 *
 * Production-readiness canon (B11):
 *   - **Probe cache** (default 2s TTL): k8s/ALB readiness probes fire 1-2 ×
 *     /sec across replicas. Without cache every probe roundtrips к YDB.
 *     A 2s cache drops DB load 10-20× while keeping probe accuracy within
 *     one drain interval. Cache is per-evaluator (DI scope), not global.
 *   - **Probe timeout** (default 2s): YDB hang must NOT translate к ALB
 *     timeout (which marks instance unhealthy AFTER 30s+ and may SIGKILL
 *     before drain). Probe fails fast → instance fails fast → ALB routes
 *     к healthy replica immediately.
 */

export type AdapterMode = 'mock' | 'sandbox' | 'live'

export interface ReadinessAdapter {
	readonly name: string
	readonly mode: AdapterMode
}

export interface ReadinessProbeInput {
	readonly appMode: 'sandbox' | 'production'
	readonly permittedMockAdapters: readonly string[]
	readonly adapters: readonly ReadinessAdapter[]
	/**
	 * Probe MUST accept `AbortSignal` — caller cancels с `AbortSignal.timeout`
	 * if YDB hangs past `probeTimeoutMs`. Implementation passes the signal к
	 * YDB driver (which honors it via `query.execute({ signal })`-style API)
	 * — see `app.ts` wiring.
	 */
	readonly probeYdb: (signal: AbortSignal) => Promise<boolean>
	readonly logger: {
		error: (obj: Record<string, unknown>, msg?: string) => void
	}
	/**
	 * Probe timeout. Default 2000ms — empirical balance: longer than YDB p99
	 * (~200ms на single-node local, ~50ms managed prod) but shorter than ALB
	 * probe timeout default (5s on YC ALB / 10s on AWS NLB).
	 */
	readonly probeTimeoutMs?: number
	/** `Date.now()` override для test determinism. */
	readonly now?: () => number
}

export interface ReadinessCheck {
	readonly name: string
	readonly ok: boolean
}

export interface ReadinessProbeResult {
	readonly status: 'ok' | 'degraded'
	readonly checks: readonly ReadinessCheck[]
	readonly statusCode: 200 | 503
}

export interface ReadinessEvaluator {
	(): Promise<ReadinessProbeResult>
}

/** Cache TTL — see canon comment header. 2s default. */
export const READINESS_CACHE_TTL_MS = 2000
export const READINESS_PROBE_TIMEOUT_MS = 2000

/**
 * Build a cached evaluator. Caller invokes the returned thunk on each probe
 * request — first call within TTL evaluates and caches; subsequent calls
 * return cached result. Cache is per-evaluator instance (DI scope), not
 * shared globally.
 *
 * Why this shape (factory, not stateless function): we want the cache key
 * to live alongside the evaluator instance, not в a module-level singleton
 * (which would leak between tests + force harder cleanup). Caller constructs
 * once at route-mount time.
 */
export function createReadinessEvaluator(input: ReadinessProbeInput): ReadinessEvaluator {
	const ttl = READINESS_CACHE_TTL_MS
	const probeTimeoutMs = input.probeTimeoutMs ?? READINESS_PROBE_TIMEOUT_MS
	const now = input.now ?? (() => Date.now())
	let cached: { result: ReadinessProbeResult; expiresAt: number } | null = null
	let inFlight: Promise<ReadinessProbeResult> | null = null

	return async (): Promise<ReadinessProbeResult> => {
		const t = now()
		if (cached !== null && cached.expiresAt > t) {
			return cached.result
		}
		// Single-flight: while one probe is in progress, parallel callers wait
		// for the same promise. Prevents thundering herd on cache miss.
		if (inFlight !== null) return inFlight
		inFlight = evaluateOnce(input, probeTimeoutMs)
			.then((result) => {
				cached = { result, expiresAt: now() + ttl }
				return result
			})
			.finally(() => {
				inFlight = null
			})
		return inFlight
	}
}

/**
 * One-shot evaluator — bypasses cache. Test seam + base building block для
 * the cached factory above.
 */
export async function evaluateReadiness(
	input: Omit<ReadinessProbeInput, 'now'>,
): Promise<ReadinessProbeResult> {
	const probeTimeoutMs = input.probeTimeoutMs ?? READINESS_PROBE_TIMEOUT_MS
	return evaluateOnce(input, probeTimeoutMs)
}

async function evaluateOnce(
	input: Omit<ReadinessProbeInput, 'now'>,
	probeTimeoutMs: number,
): Promise<ReadinessProbeResult> {
	const checks: ReadinessCheck[] = []

	// 1. YDB probe — bounded by AbortSignal.timeout. Exception OR false-return
	// OR timeout-abort → fail-closed.
	let ydbOk = false
	const controller = new AbortController()
	const timeoutId = setTimeout(() => controller.abort(), probeTimeoutMs)
	try {
		ydbOk = await input.probeYdb(controller.signal)
		if (!ydbOk) {
			input.logger.error({ check: 'ydb' }, 'readiness: YDB probe returned false')
		}
	} catch (err) {
		const aborted = controller.signal.aborted
		input.logger.error(
			{ err, check: 'ydb', timedOut: aborted, timeoutMs: probeTimeoutMs },
			aborted ? 'readiness: YDB probe exceeded probeTimeoutMs' : 'readiness: YDB probe threw',
		)
		ydbOk = false
	} finally {
		clearTimeout(timeoutId)
	}
	checks.push({ name: 'ydb', ok: ydbOk })

	// 2. Adapter inventory — production refuses if any mock/sandbox adapter
	// is registered outside the explicit whitelist.
	const whitelist = new Set(input.permittedMockAdapters)
	const offenders = input.adapters.filter(
		(a) => (a.mode === 'mock' || a.mode === 'sandbox') && !whitelist.has(a.name),
	)
	if (input.appMode === 'production' && offenders.length > 0) {
		input.logger.error(
			{
				check: 'adapters',
				offenderCount: offenders.length,
				offenderNames: offenders.map((o) => o.name),
			},
			'readiness: non-live adapters detected в production',
		)
		checks.push({ name: 'adapters', ok: false })
	} else {
		checks.push({ name: 'adapters', ok: true })
	}

	const allOk = checks.every((c) => c.ok)
	return {
		status: allOk ? 'ok' : 'degraded',
		checks,
		statusCode: allOk ? 200 : 503,
	}
}
