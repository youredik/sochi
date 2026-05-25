/**
 * Internal ops-metrics drain endpoint — Prometheus exposition format.
 *
 * **Sprint C+ Senior P1-6 fix 2026-05-23d**: ops-metrics buffer (capacity 5000)
 * was never drained — Senior expert noted the mitigation: every emitPassportScanMetric
 * also calls `c.var.logger.info` with structured fields, which YC Cloud Logging
 * captures per-instance. But buffer-fills warning logs за каждые 100 drops were
 * noise without a way to actually drain the buffer.
 *
 * This route provides:
 *   - HTTP GET `/api/internal/ops-metrics` → drains buffer, returns Prometheus
 *     text exposition format. Caller (cron / prometheus-style scraper / manual
 *     curl) consumes; buffer clears for next interval.
 *   - Token-gated (X-Internal-Token header) — prevents public scraping of
 *     internal metrics. Token resolved from env.INTERNAL_OPS_TOKEN (set via
 *     Lockbox in production; missing token = endpoint returns 503).
 *   - PII-safe — labels (outcome/identityMethod/apiModel/rklStatus) are
 *     low-cardinality enums по design.
 *
 * **Future M11+**: replace this poll endpoint with push-based YC Monitoring
 * writeMetrics() exporter when YC IAM creds wired.
 */

import { Hono } from 'hono'
import type { AppEnv } from '../../factory.ts'
import {
	getDeadlinesByTenant,
	opsMetricsBuffer,
	type OpsMetricEvent,
} from '../../lib/ops-metrics.ts'

export interface OpsMetricsRoutesDeps {
	/**
	 * Internal API token (32+ chars random). Compared in constant time via
	 * crypto.timingSafeEqual. Empty string disables endpoint (503).
	 */
	readonly internalToken: string
}

/** Prometheus exposition: ASCII-safe label value, escape `\` and `"`. */
function escapeLabelValue(v: string): string {
	return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function eventToPrometheusLine(event: OpsMetricEvent): string {
	const labels = Object.entries(event.labels)
		.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
		.join(',')
	const metricName = event.name.replace(/\./g, '_')
	// Per Prometheus exposition: <metric>{<labels>} <value> [<timestamp>]
	return `${metricName}{${labels}} ${event.value} ${event.ts}`
}

/**
 * Round 11 P1-B4 — constant-time INTERNAL_OPS_TOKEN check (extracted helper).
 * Returns null when authorized; returns Response when blocked.
 */
function checkInternalToken(c: import('hono').Context, internalToken: string): Response | null {
	if (internalToken.length === 0) {
		return c.json(
			{
				error: {
					code: 'OPS_METRICS_DISABLED',
					message:
						'INTERNAL_OPS_TOKEN не сконфигурирован — endpoint отключён в production-safe режиме',
				},
			},
			503,
		)
	}
	const providedToken = c.req.header('x-internal-token') ?? ''
	const expected = Buffer.from(internalToken.padEnd(64, ' ').slice(0, 64))
	const provided = Buffer.from(providedToken.padEnd(64, ' ').slice(0, 64))
	let mismatch = 0
	for (let i = 0; i < 64; i++) {
		mismatch |= (expected[i] ?? 0) ^ (provided[i] ?? 0)
	}
	if (mismatch !== 0 || providedToken.length !== internalToken.length) {
		return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid X-Internal-Token' } }, 401)
	}
	return null
}

export function createOpsMetricsRoutes(deps: OpsMetricsRoutesDeps) {
	return (
		new Hono<AppEnv>()
			.get('/internal/ops-metrics', (c) => {
				const unauthorized = checkInternalToken(c, deps.internalToken)
				if (unauthorized !== null) return unauthorized
				const events = opsMetricsBuffer.drain()
				const droppedAtDrain = opsMetricsBuffer.droppedCount
				opsMetricsBuffer.resetDroppedCount()
				const lines: string[] = []
				lines.push('# HELP ops_metrics_buffer_dropped_total Events dropped due to buffer overflow')
				lines.push('# TYPE ops_metrics_buffer_dropped_total counter')
				lines.push(`ops_metrics_buffer_dropped_total ${droppedAtDrain} ${Date.now()}`)
				lines.push('# HELP ops_metrics_buffer_drained_total Events drained in this poll')
				lines.push('# TYPE ops_metrics_buffer_drained_total counter')
				lines.push(`ops_metrics_buffer_drained_total ${events.length} ${Date.now()}`)
				for (const event of events) {
					lines.push(eventToPrometheusLine(event))
				}
				return c.text(lines.join('\n'), 200, {
					'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
					'Cache-Control': 'no-store',
				})
			})
			/**
			 * Round 11 P1-B4 — INTERNAL_OPS_TOKEN-gated per-tenant deadline breakdown.
			 *
			 * Per `feedback_round_10_truthful_post_review_canon` Agent B finding: public
			 * Prometheus endpoint aggregates без tenantId (low-cardinality canon), но
			 * ops needs per-tenant breakdown для targeted paging when 109-ФЗ ст.22 cliff
			 * approaches per-tenant. This endpoint exposes tenant-keyed counts protected
			 * by INTERNAL_OPS_TOKEN, NOT scraped by public Prometheus.
			 */
			.get('/internal/ops-metrics/deadlines', (c) => {
				const unauthorized = checkInternalToken(c, deps.internalToken)
				if (unauthorized !== null) return unauthorized
				const breakdown = getDeadlinesByTenant()
				const items = Array.from(breakdown.entries()).map(([tenantId, count]) => ({
					tenantId,
					count,
				}))
				return c.json({ deadlines: items, total: items.length }, 200, {
					'Cache-Control': 'no-store',
				})
			})
	)
}
