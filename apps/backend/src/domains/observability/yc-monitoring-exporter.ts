/**
 * Yandex Cloud Monitoring exporter — M9.widget.7 / A5.2 / D9.
 *
 * Bridges RUM buffer → YC Cloud Monitoring proprietary HTTP API.
 *
 * **Why proprietary not OTLP:** YC Monitoring documented at
 * `monitoring.api.cloud.yandex.net/monitoring/v2/data/write` (verified
 * 2026-03-24) is NOT an OTLP receiver. OpenTelemetry can write to it via
 * a custom exporter, but receiving spans/metrics in OTLP format is NOT
 * native. Per plan §2 D7 we bridge frontend → our backend → YC HTTP.
 *
 * **Hard limit:** 10k metrics per write batch (YC docs). We slice the
 * drained buffer accordingly + emit one POST per slice.
 *
 * **Resilience:** wraps each write in `composePolicies(circuitBreaker, retry,
 * timeout)` from `lib/resilience/index.ts` (no Cockatiel — 21mo stale per
 * `feedback_aggressive_delegacy.md`; we have our own ~100-line policies).
 *
 * **Endpoint shape (YC v2 write API canonical 2026):**
 *
 *   POST {endpoint}/monitoring/v2/data/write?folderId={folderId}&service={svc}
 *   Authorization: Bearer {iamToken}
 *   Content-Type: application/json
 *
 *   {
 *     "metrics": [
 *       { "name": "rum.lcp.value", "labels": {...}, "type": "DGAUGE",
 *         "ts": "2026-05-04T18:32:00Z", "value": 1234.5 },
 *       ...
 *     ]
 *   }
 *
 * In dev (no `YC_MONITORING_*` env) the exporter no-ops (logs at debug).
 * Production wiring lands in M11+ alongside Monium IAM credentials.
 */

import {
	circuitBreakerPolicy,
	composePolicies,
	type Policy,
	retryPolicy,
	timeoutPolicy,
} from '../../lib/resilience/index.ts'
import type { BufferedRumMetric, RumBuffer } from './rum.repo.ts'

/** Hard limit per YC docs 2026-03-24. */
export const YC_WRITE_BATCH_LIMIT = 10_000

export interface YcMonitoringConfig {
	/** Default `https://monitoring.api.cloud.yandex.net`. */
	readonly endpoint: string
	readonly folderId: string
	readonly serviceName: string
	/** IAM token resolver — refreshes per-call (tokens expire 12h). */
	readonly resolveIamToken: () => Promise<string>
	/** Optional override for `globalThis.fetch` (tests). */
	readonly fetch?: typeof globalThis.fetch
	readonly logger?: {
		readonly debug: (obj: object, msg?: string) => void
		readonly warn: (obj: object, msg?: string) => void
		readonly error: (obj: object, msg?: string) => void
	}
}

interface YcMetricPayload {
	readonly name: string
	readonly labels: Record<string, string>
	readonly type: 'DGAUGE'
	readonly ts: string
	readonly value: number
}

/**
 * Convert a buffered RUM metric → 1-or-2 YC metric payloads.
 *
 * - Always emits `rum.{metric}.value` (DGAUGE = double gauge).
 * - For INP also emits `rum.inp.input_delay`, `rum.inp.processing_duration`,
 *   `rum.inp.presentation_delay` if attribution is present (split-axis
 *   diagnosis canon per web.dev INP guidance 2026).
 *
 * Labels (low-cardinality only, per YC quota): metric_name, rating, browser,
 * os, mobile, navigation_type, tenant_slug. NEVER include selector / id /
 * ip — those would explode label cardinality.
 */
export function metricToYcPayloads(m: BufferedRumMetric): readonly YcMetricPayload[] {
	const baseLabels: Record<string, string> = {
		metric_name: m.metric,
		rating: m.rating,
		browser: m.ua.browser,
		os: m.ua.os,
		mobile: m.ua.mobile ? 'true' : 'false',
	}
	if (m.navigationType !== undefined) baseLabels.navigation_type = m.navigationType
	if (m.tenantSlug !== undefined) baseLabels.tenant_slug = m.tenantSlug

	const ts = new Date(m.serverReceivedAt).toISOString()
	const out: YcMetricPayload[] = [
		{
			name: `rum.${m.metric.toLowerCase()}.value`,
			labels: baseLabels,
			type: 'DGAUGE',
			ts,
			value: m.value,
		},
	]

	const attr = m.attribution
	if (m.metric === 'INP' && attr !== undefined) {
		const inpExtras: Array<
			['input_delay' | 'processing_duration' | 'presentation_delay', number | undefined]
		> = [
			['input_delay', attr.inputDelay],
			['processing_duration', attr.processingDuration],
			['presentation_delay', attr.presentationDelay],
		]
		for (const [name, val] of inpExtras) {
			if (val !== undefined) {
				out.push({
					name: `rum.inp.${name}`,
					labels: baseLabels,
					type: 'DGAUGE',
					ts,
					value: val,
				})
			}
		}
	}

	return out
}

export interface YcExporter {
	readonly flush: (buffer: RumBuffer) => Promise<{
		readonly written: number
		readonly skipped: number
		readonly batches: number
	}>
}

/**
 * Build YC Monitoring exporter with default policy stack:
 *   - timeout 10s per request
 *   - retry 3 attempts with exponential jitter (200ms → 5s)
 *   - circuit breaker: 5 consecutive failures → 60s open
 *
 * Returns `{flush}` — call from a `setInterval` (15s tick) OR from a graceful-
 * shutdown hook on SIGTERM.
 */
export function createYcMonitoringExporter(cfg: YcMonitoringConfig, policy?: Policy): YcExporter {
	const fetchFn = cfg.fetch ?? globalThis.fetch
	const logger = cfg.logger
	const exportPolicy =
		policy ??
		composePolicies(
			circuitBreakerPolicy({ failureThreshold: 5, resetAfterMs: 60_000 }),
			retryPolicy({
				attempts: 3,
				baseMs: 200,
				maxMs: 5_000,
				shouldRetry: (err) => {
					// 4xx are NOT retried (client error / auth invalid).
					if (err instanceof YcMonitoringHttpError && err.status >= 400 && err.status < 500) {
						return false
					}
					return true
				},
			}),
			timeoutPolicy(10_000),
		)

	return {
		async flush(buffer) {
			let written = 0
			let skipped = 0
			let batches = 0
			while (buffer.size > 0) {
				const slice = buffer.drain(YC_WRITE_BATCH_LIMIT)
				if (slice.length === 0) break
				const payloads = slice.flatMap(metricToYcPayloads)
				try {
					await exportPolicy.execute(() => writeBatch(fetchFn, cfg, payloads))
					written += slice.length
					batches++
				} catch (err) {
					skipped += slice.length
					logger?.warn({ err, sliced: slice.length }, 'YC Monitoring write failed (slice dropped)')
				}
			}
			return { written, skipped, batches }
		},
	}
}

export class YcMonitoringHttpError extends Error {
	override readonly name = 'YcMonitoringHttpError'
	readonly status: number
	constructor(status: number, body: string) {
		super(`YC Monitoring write failed: HTTP ${status}: ${body.slice(0, 256)}`)
		this.status = status
	}
}

async function writeBatch(
	fetchFn: typeof globalThis.fetch,
	cfg: YcMonitoringConfig,
	payloads: readonly YcMetricPayload[],
): Promise<void> {
	if (payloads.length === 0) return
	if (payloads.length > YC_WRITE_BATCH_LIMIT) {
		throw new RangeError(
			`writeBatch: payloads.length=${payloads.length} exceeds YC limit ${YC_WRITE_BATCH_LIMIT}`,
		)
	}
	const token = await cfg.resolveIamToken()
	const url = new URL('/monitoring/v2/data/write', cfg.endpoint)
	url.searchParams.set('folderId', cfg.folderId)
	url.searchParams.set('service', cfg.serviceName)
	const res = await fetchFn(url.toString(), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ metrics: payloads }),
	})
	if (!res.ok) {
		const body = await res.text().catch(() => '')
		throw new YcMonitoringHttpError(res.status, body)
	}
}
