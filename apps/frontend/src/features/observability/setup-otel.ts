import { trace } from '@opentelemetry/api'
import { ZoneContextManager } from '@opentelemetry/context-zone'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web'
import {
	ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
	ATTR_SERVICE_NAME,
	ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions/incubating'

/**
 * OpenTelemetry Web Tracer bootstrap — production path to Yandex Monium.
 *
 * Wire:
 *   browser spans → same-origin POST /api/otel/v1/traces → Hono proxy →
 *   `OTEL_EXPORTER_OTLP_ENDPOINT` (prod: Yandex Monium OTLP ingest).
 *
 * Monium is the canonical Yandex observability backend (same target as
 * stankoff-v2's telemetry.ts pattern). OTLP-native — no format conversion
 * needed. 152-ФЗ posture: traces never leave the RF contour; PII stripping
 * happens browser-side via span processors before export.
 *
 * FetchInstrumentation propagates W3C `traceparent` to our own backend so
 * Hono (instrumented in M5f alongside Monium credentials) can stitch
 * browser→Hono→YDB into one trace — the distributed-tracing value we're
 * paying the bundle cost for.
 *
 * Keep ONE call site in the app entry; never re-register. Browser
 * client-instrumentation spec is still marked "experimental" on
 * opentelemetry.io — budget one migration when `opentelemetry-browser`
 * consolidation repo stabilizes (~2027 per final consensus agent).
 */

const SERVICE_NAME = 'horeca-frontend'
const SERVICE_VERSION = '0.0.1'
const SERVICE_NAMESPACE = 'horeca'

let registered = false

export function setupOtel(): void {
	if (registered) return
	registered = true

	const provider = new WebTracerProvider({
		resource: resourceFromAttributes({
			[ATTR_SERVICE_NAME]: SERVICE_NAME,
			[ATTR_SERVICE_VERSION]: SERVICE_VERSION,
			'service.namespace': SERVICE_NAMESPACE,
			[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: import.meta.env.MODE,
		}),
		spanProcessors: [
			new BatchSpanProcessor(
				new OTLPTraceExporter({
					url: '/api/otel/v1/traces',
				}),
				{
					scheduledDelayMillis: 2_000,
					maxExportBatchSize: 30,
					maxQueueSize: 100,
				},
			),
		],
	})

	provider.register({
		contextManager: new ZoneContextManager(),
	})

	registerInstrumentations({
		instrumentations: [
			new FetchInstrumentation({
				// Propagate W3C `traceparent` on every fetch to our own backend.
				// Skip OTLP export calls to avoid tracing the tracer.
				propagateTraceHeaderCorsUrls: [/localhost:3001/, /\.horeca\.ru$/],
				ignoreUrls: [/\/api\/otel\//],
			}),
		],
	})
}

/** Top-level tracer for ad-hoc instrumentation (error boundary, route transitions). */
export const tracer = trace.getTracer(SERVICE_NAME, SERVICE_VERSION)
