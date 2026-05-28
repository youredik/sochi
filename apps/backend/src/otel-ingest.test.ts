/**
 * OTLP-HTTP traces ingest proxy tests.
 *
 * Round 14.6.4 adversarial-sweep #6 (2026-05-29) — pin the anonymous-ingest
 * body cap. Pre-fix `/api/otel/v1/traces` read `c.req.arrayBuffer()` без cap
 * (unbounded-body DoS vector missed by sweep #5). Telemetry cap (512 KB) is
 * higher than the 64 KB JSON-control-plane default so real browser span
 * batches pass; abuse cut off.
 */

import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { onError } from './errors/on-error.ts'
import type { AppEnv } from './factory.ts'
import { createOtelIngest } from './otel-ingest.ts'

function buildApp() {
	const root = new Hono<AppEnv>().route('/api/otel', createOtelIngest()).onError(onError)
	return root
}

describe('OTel ingest — /api/otel/v1/traces', () => {
	it('[OTEL1] small batch (no forward target) → 204', async () => {
		// No OTEL_EXPORTER_OTLP_ENDPOINT in test env → discard path, ACK 204.
		const res = await buildApp().request('/api/otel/v1/traces', {
			method: 'POST',
			headers: { 'content-type': 'application/x-protobuf' },
			body: new Uint8Array([1, 2, 3, 4]),
		})
		expect(res.status).toBe(204)
	})

	it('[OTEL2] body just under 512 KB telemetry cap → 204 (legit batch passes)', async () => {
		const justUnder = new Uint8Array(500 * 1024)
		const res = await buildApp().request('/api/otel/v1/traces', {
			method: 'POST',
			headers: { 'content-type': 'application/x-protobuf' },
			body: justUnder,
		})
		expect(res.status).toBe(204)
	})

	it('[OTEL3] body > 512 KB → 413 payload_too_large (DoS guard)', async () => {
		const tooBig = new Uint8Array(600 * 1024)
		const res = await buildApp().request('/api/otel/v1/traces', {
			method: 'POST',
			headers: { 'content-type': 'application/x-protobuf' },
			body: tooBig,
		})
		expect(res.status).toBe(413)
	})
})
