/**
 * web-vitals → OTel — strict tests (M9.6).
 *
 * Pre-done audit:
 *   [W1] reportWebVitals registers all 5 handlers (CLS/INP/LCP/FCP/TTFB)
 *   [W2] each metric callback creates OTel span с name `vital.${metric.name}`
 *   [W3] span attributes include vital.value, vital.rating, vital.id
 *   [W4] span.end() called per metric (no leaked spans)
 *   [W5] tracer name === 'frontend-vitals' (single source for OTel filtering)
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const onCLSMock = vi.fn()
const onINPMock = vi.fn()
const onLCPMock = vi.fn()
const onFCPMock = vi.fn()
const onTTFBMock = vi.fn()
vi.mock('web-vitals', () => ({
	onCLS: onCLSMock,
	onINP: onINPMock,
	onLCP: onLCPMock,
	onFCP: onFCPMock,
	onTTFB: onTTFBMock,
}))

const startSpanMock = vi.fn()
const setAttributeMock = vi.fn()
const endMock = vi.fn()
const getTracerMock = vi.fn(() => ({ startSpan: startSpanMock }))
vi.mock('@opentelemetry/api', () => ({
	trace: { getTracer: getTracerMock },
}))

const { reportWebVitals } = await import('./web-vitals')

afterEach(() => {
	vi.clearAllMocks()
})

describe('reportWebVitals — registration', () => {
	it('[W1] registers all 5 web-vitals handlers', () => {
		reportWebVitals()
		expect(onCLSMock).toHaveBeenCalledOnce()
		expect(onINPMock).toHaveBeenCalledOnce()
		expect(onLCPMock).toHaveBeenCalledOnce()
		expect(onFCPMock).toHaveBeenCalledOnce()
		expect(onTTFBMock).toHaveBeenCalledOnce()
	})

	it('[W5] tracer name === "frontend-vitals"', () => {
		reportWebVitals()
		expect(getTracerMock).toHaveBeenCalledWith('frontend-vitals')
	})
})

describe('reportWebVitals — span emission', () => {
	it('[W2] callback creates span с name vital.${name}', () => {
		startSpanMock.mockReturnValue({
			setAttribute: setAttributeMock,
			end: endMock,
		})
		reportWebVitals()
		const onCLSCallback = onCLSMock.mock.calls[0]?.[0] as (m: object) => void
		onCLSCallback({ name: 'CLS', value: 0.05, rating: 'good', id: 'v3-cls-1' })
		expect(startSpanMock).toHaveBeenCalledWith('vital.CLS')
	})

	it('[W3] span attributes include vital.value, rating, id', () => {
		startSpanMock.mockReturnValue({
			setAttribute: setAttributeMock,
			end: endMock,
		})
		reportWebVitals()
		const onLCPCallback = onLCPMock.mock.calls[0]?.[0] as (m: object) => void
		onLCPCallback({ name: 'LCP', value: 1234.5, rating: 'needs-improvement', id: 'v3-lcp-x' })
		expect(setAttributeMock).toHaveBeenCalledWith('vital.value', 1234.5)
		expect(setAttributeMock).toHaveBeenCalledWith('vital.rating', 'needs-improvement')
		expect(setAttributeMock).toHaveBeenCalledWith('vital.id', 'v3-lcp-x')
	})

	it('[W4] span.end() called once per metric (no leak)', () => {
		startSpanMock.mockReturnValue({
			setAttribute: setAttributeMock,
			end: endMock,
		})
		reportWebVitals()
		const onINPCallback = onINPMock.mock.calls[0]?.[0] as (m: object) => void
		onINPCallback({ name: 'INP', value: 200, rating: 'good', id: 'v3-inp-y' })
		expect(endMock).toHaveBeenCalledOnce()
	})
})
