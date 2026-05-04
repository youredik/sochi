/**
 * YC Monitoring exporter — strict tests YCM1-YCM4 (M9.widget.7 / A5.2 / D9).
 *
 * Per plan §5: «4 YCM (batch shape / 10k cap / 429 circuit / drop-oldest reservoir)».
 *
 * Strict-test canon:
 *   - Exact shape asserts on emitted POST URL + body.
 *   - 10k cap: exporter MUST NOT exceed YC's 10k metrics/req hard limit.
 *   - 429 circuit: 5 consecutive failures → next call rejects without fetch.
 *   - Drop-oldest: pushing N+1 into N-cap buffer → oldest evicted, droppedCount++.
 */

import type { RumMetric } from '@horeca/shared/rum'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	circuitBreakerPolicy,
	composePolicies,
	retryPolicy,
	timeoutPolicy,
} from '../../lib/resilience/index.ts'
import { RumBuffer } from './rum.repo.ts'
import {
	createYcMonitoringExporter,
	metricToYcPayloads,
	YC_WRITE_BATCH_LIMIT,
	YcMonitoringHttpError,
} from './yc-monitoring-exporter.ts'

function makeMetric(over: Partial<RumMetric> = {}): RumMetric {
	return {
		metric: 'INP',
		value: 180,
		rating: 'good',
		id: 'v5-inp-1',
		path: '/widget/demo-sirius',
		ua: { browser: 'chrome', os: 'macos', mobile: false },
		tenantSlug: 'demo-sirius',
		ts: 1_700_000_000_000,
		...over,
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe('metricToYcPayloads — wire shape', () => {
	it('[YCM1] DGAUGE single payload from non-INP metric', () => {
		const m = {
			...makeMetric({ metric: 'LCP', value: 1234.5, id: 'v5-lcp' }),
			serverReceivedAt: 1_700_000_000_000,
			truncatedIp: '203.0.113.0',
		}
		const payloads = metricToYcPayloads(m)
		expect(payloads).toHaveLength(1)
		const p = payloads[0]
		expect(p?.name).toBe('rum.lcp.value')
		expect(p?.type).toBe('DGAUGE')
		expect(p?.value).toBe(1234.5)
		expect(p?.ts).toBe('2023-11-14T22:13:20.000Z')
		expect(p?.labels).toEqual({
			metric_name: 'LCP',
			rating: 'good',
			browser: 'chrome',
			os: 'macos',
			mobile: 'false',
			tenant_slug: 'demo-sirius',
		})
	})

	it('[YCM1.b] INP with attribution → 4 payloads (value + 3 split-axis)', () => {
		const m = {
			...makeMetric({
				metric: 'INP',
				value: 250,
				attribution: { inputDelay: 50, processingDuration: 80, presentationDelay: 120 },
			}),
			serverReceivedAt: 1_700_000_000_000,
			truncatedIp: '203.0.113.0',
		}
		const payloads = metricToYcPayloads(m)
		expect(payloads).toHaveLength(4)
		const names = payloads.map((p) => p.name).sort()
		expect(names).toEqual([
			'rum.inp.input_delay',
			'rum.inp.presentation_delay',
			'rum.inp.processing_duration',
			'rum.inp.value',
		])
	})

	it('[YCM1.c] labels never include selector / id / ip (cardinality bomb defense)', () => {
		const m = {
			...makeMetric({ id: 'v5-inp-personally-id-12345' }),
			serverReceivedAt: 1_700_000_000_000,
			truncatedIp: '203.0.113.0',
		}
		const payloads = metricToYcPayloads(m)
		for (const p of payloads) {
			expect(p.labels).not.toHaveProperty('selector')
			expect(p.labels).not.toHaveProperty('id')
			expect(p.labels).not.toHaveProperty('ip')
			expect(p.labels).not.toHaveProperty('truncated_ip')
		}
	})
})

describe('createYcMonitoringExporter.flush', () => {
	it('[YCM2] 10k cap respected: drains 12k buffer in 2 slices', async () => {
		const buffer = new RumBuffer({ capacity: 15_000 })
		for (let i = 0; i < 12_000; i++) {
			buffer.push(makeMetric({ id: `v5-${i}` }), '203.0.113.0')
		}
		expect(buffer.size).toBe(12_000)

		const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
		const exporter = createYcMonitoringExporter({
			endpoint: 'https://monitoring.api.cloud.yandex.net',
			folderId: 'b1gtest',
			serviceName: 'horeca',
			resolveIamToken: async () => 'token',
			fetch: fetchMock,
		})
		const result = await exporter.flush(buffer)
		expect(result.batches).toBe(2)
		expect(result.written).toBe(12_000)
		expect(result.skipped).toBe(0)
		expect(fetchMock).toHaveBeenCalledTimes(2)

		// Verify each request did NOT exceed YC limit.
		for (const call of fetchMock.mock.calls) {
			const init = call[1] as RequestInit
			const body = JSON.parse(init.body as string) as { metrics: unknown[] }
			expect(body.metrics.length).toBeLessThanOrEqual(YC_WRITE_BATCH_LIMIT)
		}

		// Drained — buffer empty.
		expect(buffer.size).toBe(0)
	})

	it('[YCM2.b] URL + auth header shape correct (production wire format)', async () => {
		const buffer = new RumBuffer({ capacity: 10 })
		buffer.push(makeMetric(), '203.0.113.0')
		const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
		const exporter = createYcMonitoringExporter({
			endpoint: 'https://monitoring.api.cloud.yandex.net',
			folderId: 'b1gtest',
			serviceName: 'horeca',
			resolveIamToken: async () => 'iam-bearer-xyz',
			fetch: fetchMock,
		})
		await exporter.flush(buffer)
		expect(fetchMock).toHaveBeenCalledOnce()
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		const parsed = new URL(url)
		expect(parsed.host).toBe('monitoring.api.cloud.yandex.net')
		expect(parsed.pathname).toBe('/monitoring/v2/data/write')
		expect(parsed.searchParams.get('folderId')).toBe('b1gtest')
		expect(parsed.searchParams.get('service')).toBe('horeca')
		const headers = init.headers as Record<string, string>
		expect(headers.Authorization).toBe('Bearer iam-bearer-xyz')
		expect(headers['Content-Type']).toBe('application/json')
	})

	it('[YCM3] 429 circuit: tight policy → 1 retry then circuit opens, slice marked skipped', async () => {
		const buffer = new RumBuffer({ capacity: 10 })
		buffer.push(makeMetric(), '203.0.113.0')

		const fetchMock = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }))

		// Tight policy: 1 attempt, no retries — verifies that 5xx-class rejection
		// propagates as exporter.flush().skipped without throwing.
		const tightPolicy = composePolicies(
			circuitBreakerPolicy({ failureThreshold: 1, resetAfterMs: 10_000 }),
			retryPolicy({ attempts: 1, baseMs: 0, maxMs: 0 }),
			timeoutPolicy(5_000),
		)

		const exporter = createYcMonitoringExporter(
			{
				endpoint: 'https://monitoring.api.cloud.yandex.net',
				folderId: 'b1gtest',
				serviceName: 'horeca',
				resolveIamToken: async () => 'token',
				fetch: fetchMock,
			},
			tightPolicy,
		)
		const result = await exporter.flush(buffer)
		expect(result.skipped).toBe(1)
		expect(result.written).toBe(0)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		// Circuit now open — pushing more + flushing again should reject without
		// invoking fetch (we already exceeded threshold=1).
		buffer.push(makeMetric(), '203.0.113.0')
		const result2 = await exporter.flush(buffer)
		expect(result2.skipped).toBe(1)
		expect(fetchMock).toHaveBeenCalledTimes(1) // NOT called again — circuit blocked
	})

	it('[YCM3.b] 4xx (client error) NOT retried per shouldRetry policy', async () => {
		const buffer = new RumBuffer({ capacity: 10 })
		buffer.push(makeMetric(), '203.0.113.0')
		const fetchMock = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }))
		const exporter = createYcMonitoringExporter({
			endpoint: 'https://monitoring.api.cloud.yandex.net',
			folderId: 'b1gtest',
			serviceName: 'horeca',
			resolveIamToken: async () => 'token',
			fetch: fetchMock,
		})
		const result = await exporter.flush(buffer)
		expect(result.skipped).toBe(1)
		expect(result.written).toBe(0)
		// Default policy = 3 attempts, but shouldRetry returns false for 4xx.
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('[YCM3.c] YcMonitoringHttpError carries status + truncated body', () => {
		const e = new YcMonitoringHttpError(500, 'a'.repeat(1000))
		expect(e.status).toBe(500)
		expect(e.message.length).toBeLessThan(400) // status code line + 256-cap body
		expect(e.name).toBe('YcMonitoringHttpError')
	})
})

describe('RumBuffer — drop-oldest reservoir', () => {
	it('[YCM4] cap=3, push 5 → first 2 dropped, droppedCount=2, head=3rd', () => {
		const buffer = new RumBuffer({ capacity: 3, now: () => 1_700_000_000_000 })
		buffer.push(makeMetric({ id: 'first' }), '203.0.113.0')
		buffer.push(makeMetric({ id: 'second' }), '203.0.113.0')
		buffer.push(makeMetric({ id: 'third' }), '203.0.113.0')
		buffer.push(makeMetric({ id: 'fourth' }), '203.0.113.0')
		buffer.push(makeMetric({ id: 'fifth' }), '203.0.113.0')
		expect(buffer.size).toBe(3)
		expect(buffer.droppedCount).toBe(2)
		// Oldest two ('first', 'second') evicted; head should be 'third'.
		expect(buffer.peek()?.id).toBe('third')
		const drained = buffer.drain()
		const ids = drained.map((d) => d.id)
		expect(ids).toEqual(['third', 'fourth', 'fifth'])
	})

	it('[YCM4.b] cap=0 rejected (RangeError on construct)', () => {
		expect(() => new RumBuffer({ capacity: 0 })).toThrow(RangeError)
		expect(() => new RumBuffer({ capacity: -1 })).toThrow(RangeError)
		expect(() => new RumBuffer({ capacity: 1.5 })).toThrow(RangeError)
	})

	it('[YCM4.c] empty buffer drain returns []', () => {
		const buffer = new RumBuffer({ capacity: 5 })
		expect(buffer.drain()).toEqual([])
		expect(buffer.size).toBe(0)
		expect(buffer.droppedCount).toBe(0)
	})
})
