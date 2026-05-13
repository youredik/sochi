/**
 * RUM phantom-session filter — strict tests SR-RUM (M9.widget.7 / A5.4 / R2 §7).
 *
 * Per `plans/m9_widget_7_canonical.md` §2 D11 + R2 §7:
 *   «while document.prerendering is true we skip emission entirely —
 *    Speculation Rules prefetch SHOULD NOT generate phantom-session RUM
 *    rows».
 *
 * Verified by mocking `web-vitals/attribution` callbacks + global `document`.
 * If `document.prerendering === true` at the moment a metric fires, the
 * batcher MUST NOT receive it (`bufferSize === 0`).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const onCLSMock = mock()
const onINPMock = mock()
const onLCPMock = mock()
const onFCPMock = mock()
const onTTFBMock = mock()

mock.module('web-vitals/attribution', () => ({
	onCLS: onCLSMock,
	onINP: onINPMock,
	onLCP: onLCPMock,
	onFCP: onFCPMock,
	onTTFB: onTTFBMock,
}))

afterEach(() => {
	mock.clearAllMocks()
})

beforeEach(() => {
	// Default: not prerendering.
	Object.defineProperty(document, 'prerendering', {
		configurable: true,
		value: false,
	})
})

function makeMetric(over: Partial<{ name: string; value: number; rating: string }> = {}): {
	name: string
	value: number
	rating: string
	id: string
	navigationType?: string
	attribution?: object
} {
	return {
		name: 'INP',
		value: 180,
		rating: 'good',
		id: 'v5-inp-test',
		...over,
	}
}

const baseTransport = {
	fetch: mock().mockResolvedValue(new Response('', { status: 200 })),
	sendBeacon: mock().mockReturnValue(true),
	now: () => 1_700_000_000_000,
	setTimeout: mock(),
	clearTimeout: mock(),
	userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4) AppleWebKit/537.36 Chrome/124.0.0.0',
	path: '/widget/demo-sirius',
	tenantSlug: 'demo-sirius',
}

describe('[SR-RUM1] phantom-session filter (R2 §7)', () => {
	it('document.prerendering=true → metric IS skipped (bufferSize=0)', async () => {
		Object.defineProperty(document, 'prerendering', { configurable: true, value: true })
		const { startRum } = await import('./index.ts')
		const handle = startRum(baseTransport)
		const cb = onCLSMock.mock.calls[0]?.[0] as (m: object) => void
		cb(makeMetric({ name: 'CLS', value: 0.05, rating: 'good' }))
		expect(handle.bufferSize()).toBe(0)
	})

	it('document.prerendering=false → metric IS queued (bufferSize=1)', async () => {
		Object.defineProperty(document, 'prerendering', { configurable: true, value: false })
		const { startRum } = await import('./index.ts')
		const handle = startRum(baseTransport)
		const cb = onINPMock.mock.calls[0]?.[0] as (m: object) => void
		cb(makeMetric({ name: 'INP', value: 200, rating: 'good' }))
		expect(handle.bufferSize()).toBe(1)
	})

	it('mixed: 2 metrics, prerendering toggles between → only post-activate one queued', async () => {
		// Simulate: page activates (prerendering: false), 1 metric fires.
		// Browser doesn't actually toggle back to true mid-session, but we
		// verify the predicate is evaluated PER metric (not memoized).
		const { startRum } = await import('./index.ts')
		const handle = startRum(baseTransport)
		const cb = onLCPMock.mock.calls[0]?.[0] as (m: object) => void

		// First metric fires while pre-rendering.
		Object.defineProperty(document, 'prerendering', { configurable: true, value: true })
		cb(makeMetric({ name: 'LCP', value: 1234, rating: 'good' }))
		expect(handle.bufferSize()).toBe(0)

		// Second metric after activation.
		Object.defineProperty(document, 'prerendering', { configurable: true, value: false })
		cb(makeMetric({ name: 'LCP', value: 1500, rating: 'good' }))
		expect(handle.bufferSize()).toBe(1)
	})
})
