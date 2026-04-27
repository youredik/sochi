/**
 * /api/health/adapters route smoke test — verifies the truthful runtime view.
 *
 * Strategy: mount a minimal Hono app reusing the same Hono handler shape that
 * `app.ts` uses, so we exercise the route logic in isolation without booting
 * the full backend (no YDB, no auth). This is the canonical pattern in this
 * repo per `routes/admin/tax.test.ts`.
 */

import { Hono } from 'hono'
import { beforeEach, describe, expect, test } from 'vitest'
import { __resetAdapterRegistry, listAdapters, registerAdapter } from './index.ts'

type AppMode = 'sandbox' | 'production'

function buildHealthRoute(opts: { appMode: AppMode; permittedMockAdapters: readonly string[] }) {
	return new Hono().get('/health/adapters', (c) => {
		const adapters = listAdapters().map((a) => ({
			name: a.name,
			category: a.category,
			mode: a.mode,
			description: a.description,
			providerVersion: a.providerVersion ?? null,
		}))
		const whitelist = new Set(opts.permittedMockAdapters)
		const offenders = adapters.filter(
			(a) => (a.mode === 'mock' || a.mode === 'sandbox') && !whitelist.has(a.name),
		)
		const isReady = opts.appMode === 'sandbox' || offenders.length === 0
		return c.json(
			{
				status: isReady ? ('ok' as const) : ('degraded' as const),
				appMode: opts.appMode,
				adapters,
				offendersInProduction: offenders.map((o) => o.name),
				time: new Date().toISOString(),
			},
			isReady ? 200 : 503,
		)
	})
}

describe('/health/adapters', () => {
	beforeEach(() => __resetAdapterRegistry())

	test('[H1] empty registry → 200 ok with empty adapters[]', async () => {
		const app = buildHealthRoute({ appMode: 'sandbox', permittedMockAdapters: [] })
		const res = await app.request('/health/adapters')
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.status).toBe('ok')
		expect(body.adapters).toEqual([])
		expect(body.offendersInProduction).toEqual([])
		expect(body.appMode).toBe('sandbox')
	})

	test('[H2] sandbox mode + mock adapter → 200 (mocks permitted in sandbox)', async () => {
		registerAdapter({
			name: 'payment.stub',
			category: 'payment',
			mode: 'mock',
			description: 'stub',
		})
		const app = buildHealthRoute({ appMode: 'sandbox', permittedMockAdapters: [] })
		const res = await app.request('/health/adapters')
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.status).toBe('ok')
		expect(body.adapters).toHaveLength(1)
		expect(body.adapters[0]).toMatchObject({
			name: 'payment.stub',
			category: 'payment',
			mode: 'mock',
			providerVersion: null,
		})
		// In sandbox, offendersInProduction should still list mocks for visibility
		expect(body.offendersInProduction).toEqual(['payment.stub'])
	})

	test('[H3] production mode + mock adapter without whitelist → 503 degraded', async () => {
		registerAdapter({
			name: 'payment.stub',
			category: 'payment',
			mode: 'mock',
			description: 'stub',
		})
		const app = buildHealthRoute({ appMode: 'production', permittedMockAdapters: [] })
		const res = await app.request('/health/adapters')
		expect(res.status).toBe(503)
		const body = await res.json()
		expect(body.status).toBe('degraded')
		expect(body.offendersInProduction).toEqual(['payment.stub'])
	})

	test('[H4] production mode + mock adapter WITH whitelist → 200', async () => {
		registerAdapter({ name: 'epgu.stub', category: 'epgu', mode: 'mock', description: 'stub' })
		const app = buildHealthRoute({ appMode: 'production', permittedMockAdapters: ['epgu.stub'] })
		const res = await app.request('/health/adapters')
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.status).toBe('ok')
		expect(body.offendersInProduction).toEqual([])
	})

	test('[H5] production mode + mix of live + mock + whitelisted-sandbox → 503 only on non-whitelisted', async () => {
		registerAdapter({ name: 'a.live', category: 'payment', mode: 'live', description: '' })
		registerAdapter({ name: 'b.mock', category: 'epgu', mode: 'mock', description: '' })
		registerAdapter({ name: 'c.sandbox', category: 'fiscal', mode: 'sandbox', description: '' })
		const app = buildHealthRoute({
			appMode: 'production',
			permittedMockAdapters: ['c.sandbox'],
		})
		const res = await app.request('/health/adapters')
		expect(res.status).toBe(503)
		const body = await res.json()
		expect(body.offendersInProduction).toEqual(['b.mock'])
		// All three still listed in adapters[] for visibility
		expect(body.adapters).toHaveLength(3)
	})

	test('[H6] response shape is stable (RPC consumer relies on union narrowing)', async () => {
		const app = buildHealthRoute({ appMode: 'sandbox', permittedMockAdapters: [] })
		const res = await app.request('/health/adapters')
		const body = await res.json()
		// All required fields present, even when arrays are empty
		expect(Object.keys(body).sort()).toEqual([
			'adapters',
			'appMode',
			'offendersInProduction',
			'status',
			'time',
		])
		expect(typeof body.time).toBe('string')
		expect(new Date(body.time).toString()).not.toBe('Invalid Date')
	})

	test('[H7] adapters[] preserves provider metadata (version + description)', async () => {
		registerAdapter({
			name: 'payment.yookassa',
			category: 'payment',
			mode: 'live',
			description: 'YooKassa API v3',
			providerVersion: 'v3',
		})
		const app = buildHealthRoute({ appMode: 'production', permittedMockAdapters: [] })
		const res = await app.request('/health/adapters')
		const body = await res.json()
		expect(body.adapters[0]).toEqual({
			name: 'payment.yookassa',
			category: 'payment',
			mode: 'live',
			description: 'YooKassa API v3',
			providerVersion: 'v3',
		})
	})
})
