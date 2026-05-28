import { Hono } from 'hono'
import type { AppEnv } from './factory.ts'
import { MAX_TELEMETRY_BODY_BYTES, publicBodyCap } from './middleware/public-body-cap.ts'

/**
 * Same-origin OTLP-HTTP traces ingest proxy — prod forwarder to Yandex Monium.
 *
 * Frontend (OTel Web Tracer) POSTs protobuf-or-JSON OTLP payloads here;
 * we log-and-discard in dev, and forward to `OTEL_EXPORTER_OTLP_ENDPOINT`
 * in prod (Yandex Monium — canonical OTLP-native Yandex observability
 * backend, same target stankoff-v2 uses). Keeping this on the same origin
 * as the SPA avoids CORS + preserves the browser's W3C `traceparent`
 * propagation into our app.ts Hono middleware tree (Hono OTel middleware
 * to be wired in M5f alongside Monium credentials).
 *
 * 152-ФЗ posture: personal data does not leave RF because the forwarder
 * target is Monium inside Yandex Cloud, not Sentry SaaS. PII stripping
 * happens browser-side via span processors before export.
 *
 * Returns 204 empty on success (OTLP spec); on forwarding failure it
 * still ACKs 204 — we MUST NOT surface backend-infra errors to the
 * frontend tracer, which would itself error-loop via FetchInstrumentation.
 */
export function createOtelIngest() {
	const app = new Hono<AppEnv>()

	// Round 14.6.4 adversarial-sweep #6 (2026-05-29) — anonymous OTLP ingest
	// reads `c.req.arrayBuffer()` (full buffer) before forward. Без cap →
	// unbounded-body DoS. Telemetry cap (512 KB) higher than JSON-default так
	// real browser span batches pass; cuts off abuse. Sweep #5 missed this.
	app.use('/*', publicBodyCap(MAX_TELEMETRY_BODY_BYTES))

	app.post('/v1/traces', async (c) => {
		const forwardTo = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
		if (forwardTo && forwardTo.length > 0) {
			const body = await c.req.arrayBuffer()
			try {
				await fetch(`${forwardTo}/v1/traces`, {
					method: 'POST',
					headers: {
						'Content-Type': c.req.header('content-type') ?? 'application/x-protobuf',
					},
					body,
				})
			} catch (err) {
				// Optional-chain logger — matches `errors/on-error.ts` convention.
				// Defensive: ingest must ACK 204 even if logger middleware absent
				// (route could theoretically run before pinoLogger in some mount
				// orders). Sweep #6 caught unguarded deref → 500 instead of 204.
				c.var.logger?.warn({ err, forwardTo }, 'OTel forward failed (suppressed)')
			}
		} else if (process.env.NODE_ENV !== 'production') {
			c.var.logger?.debug('otel trace ingested (dev: discard)')
		}
		return c.body(null, 204)
	})

	return app
}
