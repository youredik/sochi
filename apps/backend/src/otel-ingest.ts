import { Hono } from 'hono'
import type { AppEnv } from './factory.ts'

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
				c.var.logger.warn({ err, forwardTo }, 'OTel forward failed (suppressed)')
			}
		} else if (process.env.NODE_ENV !== 'production') {
			c.var.logger.debug('otel trace ingested (dev: discard)')
		}
		return c.body(null, 204)
	})

	return app
}
