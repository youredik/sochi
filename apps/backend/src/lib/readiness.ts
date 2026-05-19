/**
 * Readiness probe evaluator (B7 info-leak fix, 2026-05-19).
 *
 * Pure-function variant of the `/health/ready` route logic — extracted so
 * info-leak shape regressions break in fast unit tests, not in production
 * ALB log forwarding incidents.
 *
 * Info-leak canon (OWASP API3:2023 Excessive Data Exposure):
 *   - Public probe body MUST contain only `{name, ok}` per check + `status` +
 *     `time`. NEVER include `error: String(err)` (YDB stack traces, exception
 *     messages), NEVER `offenderNames` (adapter inventory enumeration), NEVER
 *     internal topology hints.
 *   - Operator detail (YDB exception, adapter names) goes к structured
 *     `logger.error` ONLY — operators read aggregated logs (secured); ALB
 *     access-log forwarders may surface response bodies к downstream pipelines.
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
	readonly probeYdb: () => Promise<boolean>
	readonly logger: {
		error: (obj: Record<string, unknown>, msg?: string) => void
	}
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

/**
 * Evaluate readiness state — single seam consumed by the `/health/ready`
 * route handler. Public-shaped: returns only safe fields. Operator detail
 * flows к `logger.error`.
 *
 * Fail-closed: ANY check fails → 503 + status='degraded'.
 */
export async function evaluateReadiness(input: ReadinessProbeInput): Promise<ReadinessProbeResult> {
	const checks: ReadinessCheck[] = []

	// 1. YDB probe — must return true. Exception OR false-return → fail-closed.
	let ydbOk = false
	try {
		ydbOk = await input.probeYdb()
		if (!ydbOk) {
			input.logger.error({ check: 'ydb' }, 'readiness: YDB probe returned false')
		}
	} catch (err) {
		input.logger.error({ err, check: 'ydb' }, 'readiness: YDB probe threw')
		ydbOk = false
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
