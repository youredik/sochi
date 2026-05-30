/**
 * Drain guard middleware — integration tests via app.request.
 *
 * Pins the actual Hono middleware behaviour (503 + Retry-After body shape +
 * health exemption) so a regression that lets late traffic through to a closing
 * YDB driver (→ 500) breaks here.
 */

import { Hono } from 'hono'
import { afterEach, describe, expect, test } from 'bun:test'
import type { AppEnv } from '../factory.ts'
import { __resetLifecycleForTesting, beginDraining } from '../lib/lifecycle.ts'
import { drainGuard } from './drain-guard.ts'

afterEach(__resetLifecycleForTesting)

function appWithGuard() {
	const app = new Hono<AppEnv>()
	app.use('*', drainGuard)
	app.get('/api/v1/properties', (c) => c.json({ ok: true }))
	app.post('/api/auth/sign-in/magic-link', (c) => c.json({ ok: true }))
	app.get('/health/live', (c) => c.json({ status: 'ok' }))
	return app
}

describe('drainGuard middleware', () => {
	test('not draining → request passes through (200)', async () => {
		const res = await appWithGuard().request('/api/v1/properties')
		expect(res.status).toBe(200)
	})

	test('draining → 503 + Retry-After + SERVICE_DRAINING body on API GET', async () => {
		beginDraining()
		const res = await appWithGuard().request('/api/v1/properties')
		expect(res.status).toBe(503)
		expect(res.headers.get('Retry-After')).toBe('2')
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('SERVICE_DRAINING')
	})

	test('draining → 503 on the magic-link POST (the smoke [E2] failure path)', async () => {
		beginDraining()
		const res = await appWithGuard().request('/api/auth/sign-in/magic-link', { method: 'POST' })
		expect(res.status).toBe(503)
	})

	test('draining → /health/live stays 200 (liveness exempt, YC must not kill)', async () => {
		beginDraining()
		const res = await appWithGuard().request('/health/live')
		expect(res.status).toBe(200)
	})
})
