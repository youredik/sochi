import { trace } from '@opentelemetry/api'
import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals'

/**
 * `reportWebVitals` — wires WebVitals 5 core metrics to OTel tracer.
 *
 * **2026/2027 modern canon (web-vitals v5 + OTel semantic-conventions):**
 *   - **CLS** — Cumulative Layout Shift (visual stability)
 *   - **INP** — Interaction to Next Paint (responsiveness, replaces FID)
 *   - **LCP** — Largest Contentful Paint (loading)
 *   - **FCP** — First Contentful Paint (paint)
 *   - **TTFB** — Time to First Byte (network)
 *
 * Per `project_observability_stack.md` memory: tracing code production-grade
 * сейчас, exporter no-op до Monium activation. Same pattern для vitals —
 * spans created via `@opentelemetry/api`, exporter wires когда flip switch.
 *
 * Each metric → 1 span с `vital.value` + `vital.rating` + `vital.id`
 * attributes per OTel semantic-conventions 2026 vitals draft.
 *
 * Called once after React mount (main.tsx) — web-vitals handlers are idempotent
 * + survive across SPA navigations (page-load metrics fire only once anyway).
 */
export function reportWebVitals(): void {
	const tracer = trace.getTracer('frontend-vitals')

	const emit = (metric: { name: string; value: number; rating: string; id: string }) => {
		const span = tracer.startSpan(`vital.${metric.name}`)
		span.setAttribute('vital.value', metric.value)
		span.setAttribute('vital.rating', metric.rating)
		span.setAttribute('vital.id', metric.id)
		span.end()
	}

	onCLS(emit)
	onINP(emit)
	onLCP(emit)
	onFCP(emit)
	onTTFB(emit)
}
