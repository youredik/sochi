/**
 * AsyncLocalStorage propagation tests.
 *
 * Guarantees we rely on:
 *   1. `tryRequestContext()` returns `undefined` outside a request.
 *   2. `requestContext()` throws outside a request (guards against silent misuse).
 *   3. Inside a Hono request handler, `currentRequestId()` matches the one set
 *      by `hono/request-id` middleware AND the `X-Request-Id` response header.
 *   4. Context survives `await`, `setImmediate`, and nested promise chains —
 *      this is the core guarantee of AsyncLocalStorage and the reason we
 *      can trust it for logging/tracing deeply nested code.
 */
import { Hono } from 'hono'
import { contextStorage } from 'hono/context-storage'
import { requestId } from 'hono/request-id'
import { describe, expect, test } from 'vitest'
import { currentRequestId, requestContext, tryRequestContext } from './context.ts'
import type { AppEnv } from './factory.ts'

describe('requestContext', () => {
	test('tryRequestContext() returns undefined outside request scope', () => {
		expect(tryRequestContext()).toBeUndefined()
	})

	test('requestContext() throws outside request scope (silent misuse guard)', () => {
		expect(() => requestContext()).toThrow()
	})

	test('currentRequestId() inside handler equals the X-Request-Id response header', async () => {
		const app = new Hono<AppEnv>()
			.use(contextStorage())
			.use(requestId())
			.get('/probe', (c) => {
				const fromVar = c.var.requestId
				const fromStorage = currentRequestId()
				return c.json({ fromVar, fromStorage })
			})

		const res = await app.request('/probe')
		expect(res.status).toBe(200)
		const body = (await res.json()) as { fromVar: string; fromStorage: string }
		expect(body.fromVar).toMatch(/^[0-9a-f-]{8,}/)
		expect(body.fromStorage).toBe(body.fromVar)
		expect(res.headers.get('x-request-id')).toBe(body.fromVar)
	})

	test('context survives await + setImmediate + nested promise chain', async () => {
		const app = new Hono<AppEnv>()
			.use(contextStorage())
			.use(requestId())
			.get('/nested', async (c) => {
				const top = c.var.requestId

				await new Promise((r) => setImmediate(r))
				const afterImmediate = currentRequestId()

				const afterPromiseChain = await Promise.resolve()
					.then(() => Promise.resolve())
					.then(() => currentRequestId())

				await new Promise((r) => setTimeout(r, 0))
				const afterTimeout = currentRequestId()

				return c.json({ top, afterImmediate, afterPromiseChain, afterTimeout })
			})

		const res = await app.request('/nested')
		const body = (await res.json()) as {
			top: string
			afterImmediate: string
			afterPromiseChain: string
			afterTimeout: string
		}
		expect(body.afterImmediate).toBe(body.top)
		expect(body.afterPromiseChain).toBe(body.top)
		expect(body.afterTimeout).toBe(body.top)
	})

	test('concurrent requests keep isolated contexts (no leak between requests)', async () => {
		const app = new Hono<AppEnv>()
			.use(contextStorage())
			.use(requestId())
			.get('/iso', async (c) => {
				// Force an async gap so the event loop can interleave with a parallel request.
				await new Promise((r) => setImmediate(r))
				return c.json({ id: currentRequestId(), fromVar: c.var.requestId })
			})

		const [a, b] = await Promise.all([app.request('/iso'), app.request('/iso')])
		const aBody = (await a.json()) as { id: string; fromVar: string }
		const bBody = (await b.json()) as { id: string; fromVar: string }
		expect(aBody.id).toBe(aBody.fromVar)
		expect(bBody.id).toBe(bBody.fromVar)
		expect(aBody.id).not.toBe(bBody.id)
	})
})
