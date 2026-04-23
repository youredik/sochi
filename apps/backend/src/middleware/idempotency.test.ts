/**
 * Idempotency-Key middleware — integration tests against real YDB.
 *
 * Business invariants (per IETF draft-ietf-httpapi-idempotency-key-header-07
 * Oct 2025 + mandatory strict-tests checklist):
 *
 *   Header semantics:
 *     [IM1] First request: handler runs; row stored.
 *     [IM2] Replay with SAME key + SAME body: returns cached (status, body)
 *           verbatim; handler does NOT run again.
 *     [IM3] Replay with SAME key + DIFFERENT body: 422 IDEMPOTENCY_KEY_CONFLICT;
 *           handler does NOT run; stored record untouched.
 *     [IM4] Missing `Idempotency-Key`: middleware is a pass-through; handler
 *           runs every time; no row stored.
 *     [IM5] Method filter: GET/HEAD bypass the middleware (no row stored
 *           even if the header is present — the idempotency model applies only
 *           to non-idempotent methods).
 *
 *   Fingerprint composition:
 *     [IM6] Same key + same body on DIFFERENT path → fresh run, fresh row
 *           (fingerprint includes path).
 *     [IM7] Same key + same body on DIFFERENT method (POST vs PATCH) → fresh
 *           run (fingerprint includes method).
 *
 *   Tenant isolation (per mandatory checklist — every write method):
 *     [IM8] Same key+body in DIFFERENT tenants → two independent stored rows;
 *           each tenant's handler runs independently.
 *
 *   Persistence & TTL:
 *     [IM9] Stored record matches the response BODY AND STATUS exactly
 *           (including non-2xx — cache the error responses too if they come
 *           back via our onError handler).
 *
 * Requires local YDB (migration 0004 creates the `idempotencyKey` table).
 */
import { newId } from '@horeca/shared'
import { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { onError } from '../errors/on-error.ts'
import type { AppEnv } from '../factory.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../tests/db-setup.ts'
import { createIdempotencyRepo } from './idempotency.repo.ts'
import { idempotencyMiddleware } from './idempotency.ts'

const TENANT_A = newId('organization')
const TENANT_B = newId('organization')

describe('idempotencyMiddleware', { tags: ['db'], timeout: 30_000 }, () => {
	let repo: ReturnType<typeof createIdempotencyRepo>
	const createdKeys: Array<{ tenantId: string; key: string }> = []

	beforeAll(async () => {
		await setupTestDb()
		repo = createIdempotencyRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const k of createdKeys) {
			await sql`DELETE FROM idempotencyKey WHERE tenantId = ${k.tenantId} AND key = ${k.key}`
		}
		await teardownTestDb()
	})

	const track = (tenantId: string, key: string) => createdKeys.push({ tenantId, key })

	type AppVars = AppEnv['Variables']

	/**
	 * Build a Hono test app with the middleware + a counting handler that
	 * echoes its body. The stub-tenant middleware sets tenantId (production
	 * `tenantMiddleware` needs a full session, which we avoid for pure
	 * middleware tests).
	 */
	function mkApp(tenantId: string) {
		const handler = vi.fn(async (body: unknown) => ({ echoed: body, n: Math.random() }))
		// All routes declared upfront — Hono freezes its matcher on first
		// `app.request()`; late `.post(...)` after that throws.
		const app = new Hono<AppEnv>()
		app.onError(onError)
		app
			.use('*', async (c, next) => {
				c.set('tenantId', tenantId as AppVars['tenantId'])
				return next()
			})
			.use('*', idempotencyMiddleware(repo))
			.post('/echo', async (c) => {
				const body = await c.req.json()
				return c.json(await handler(body), 201)
			})
			.patch('/echo', async (c) => {
				const body = await c.req.json()
				return c.json(await handler(body), 200)
			})
			.post('/echo2', async (c) => {
				const body = await c.req.json()
				return c.json(await handler(body), 201)
			})
			.get('/ping', async (c) => {
				handler(null)
				return c.json({ ok: true }, 200)
			})
		return { app, handler }
	}

	async function post(
		app: Hono<AppEnv>,
		path: string,
		body: unknown,
		key?: string,
		method: 'POST' | 'PATCH' = 'POST',
	) {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' }
		if (key) headers['Idempotency-Key'] = key
		return app.request(path, {
			method,
			headers,
			body: JSON.stringify(body),
		})
	}

	// -------------------------------------------------------------------------

	let keyCounter = 0
	const mkKey = () => {
		const k = `test-${Date.now()}-${++keyCounter}`
		track(TENANT_A, k)
		return k
	}

	beforeEach(() => {
		// New counter space per test to avoid cross-test collisions in keys.
		keyCounter++
	})

	test('[IM1,IM9] first call stores exact response (status+body)', async () => {
		const { app, handler } = mkApp(TENANT_A)
		const key = mkKey()
		const res = await post(app, '/echo', { x: 1 }, key)
		expect(res.status).toBe(201)
		const body = await res.json()
		expect(handler).toHaveBeenCalledTimes(1)

		const stored = await repo.find(TENANT_A, key)
		expect(stored?.responseStatus).toBe(201)
		expect(stored?.responseBody).toEqual(body)
	})

	test('[IM2] replay with same key+body returns cached response; handler NOT re-run', async () => {
		const { app, handler } = mkApp(TENANT_A)
		const key = mkKey()
		const first = await post(app, '/echo', { x: 2 }, key)
		const firstBody = await first.json()
		expect(handler).toHaveBeenCalledTimes(1)

		const second = await post(app, '/echo', { x: 2 }, key)
		expect(second.status).toBe(first.status)
		expect(await second.json()).toEqual(firstBody)
		// Crucially: handler was called only ONCE across both requests.
		expect(handler).toHaveBeenCalledTimes(1)
	})

	test('[IM3] replay with same key + different body → 422 IDEMPOTENCY_KEY_CONFLICT', async () => {
		const { app, handler } = mkApp(TENANT_A)
		const key = mkKey()
		await post(app, '/echo', { x: 3 }, key)
		expect(handler).toHaveBeenCalledTimes(1)

		const conflict = await post(app, '/echo', { x: 999 }, key)
		expect(conflict.status).toBe(422)
		// Handler NOT invoked on the conflict path.
		expect(handler).toHaveBeenCalledTimes(1)
	})

	test('[IM3-followup] stored record preserved after 422 (first write wins)', async () => {
		const { app } = mkApp(TENANT_A)
		const key = mkKey()
		await post(app, '/echo', { keep: 'me' }, key)
		await post(app, '/echo', { different: true }, key) // 422 path
		const stored = await repo.find(TENANT_A, key)
		// Body is still the original response to {keep:'me'}, not overwritten.
		const parsed = stored?.responseBody as { echoed: { keep: string } }
		expect(parsed.echoed).toEqual({ keep: 'me' })
	})

	test('[IM4] no header → middleware is a pass-through (nothing stored)', async () => {
		const { app, handler } = mkApp(TENANT_A)
		const first = await post(app, '/echo', { y: 1 })
		const second = await post(app, '/echo', { y: 1 })
		expect(handler).toHaveBeenCalledTimes(2)
		// Different random responses (new `n` on each call)
		const firstBody = (await first.json()) as { n: number }
		const secondBody = (await second.json()) as { n: number }
		expect(firstBody.n).not.toBe(secondBody.n)
	})

	test('[IM5] GET bypasses middleware even with Idempotency-Key header present', async () => {
		const { app, handler } = mkApp(TENANT_A)
		const key = mkKey()
		await app.request('/ping', { method: 'GET', headers: { 'Idempotency-Key': key } })
		await app.request('/ping', { method: 'GET', headers: { 'Idempotency-Key': key } })
		// Handler ran twice (GET is a pure read, no caching).
		expect(handler).toHaveBeenCalledTimes(2)
		// No row was stored.
		expect(await repo.find(TENANT_A, key)).toBeNull()
	})

	test('[IM6] same key + same body on DIFFERENT path → 422 (path is in fingerprint)', async () => {
		const { app } = mkApp(TENANT_A)
		const key = mkKey()
		const res1 = await post(app, '/echo', { same: true }, key)
		const res2 = await post(app, '/echo2', { same: true }, key)
		expect(res1.status).toBe(201)
		// Same key, but path differs → stored fingerprint (for /echo) doesn't
		// match the new fingerprint (for /echo2) → 422 per IETF §2.7.
		expect(res2.status).toBe(422)
	})

	test('[IM7] same key + same body on DIFFERENT method → 422 (method is in fingerprint)', async () => {
		const { app } = mkApp(TENANT_A)
		const key = mkKey()
		await post(app, '/echo', { x: 7 }, key, 'POST')
		const patched = await post(app, '/echo', { x: 7 }, key, 'PATCH')
		expect(patched.status).toBe(422)
	})

	test('[IM8] tenant isolation: same key in different tenants = independent rows', async () => {
		const keyShared = mkKey()
		track(TENANT_B, keyShared)
		const { app: appA, handler: handlerA } = mkApp(TENANT_A)
		const { app: appB, handler: handlerB } = mkApp(TENANT_B)

		await post(appA, '/echo', { who: 'A' }, keyShared)
		await post(appB, '/echo', { who: 'B' }, keyShared)
		// Each tenant ran its own handler despite shared key string.
		expect(handlerA).toHaveBeenCalledTimes(1)
		expect(handlerB).toHaveBeenCalledTimes(1)

		const rowA = await repo.find(TENANT_A, keyShared)
		const rowB = await repo.find(TENANT_B, keyShared)
		expect(rowA).not.toBeNull()
		expect(rowB).not.toBeNull()
		// Stored bodies reflect the per-tenant inputs.
		const bodyA = rowA?.responseBody as { echoed: { who: string } }
		const bodyB = rowB?.responseBody as { echoed: { who: string } }
		expect(bodyA.echoed.who).toBe('A')
		expect(bodyB.echoed.who).toBe('B')
	})
})
