/**
 * Shared `onError` handler precedence tests.
 *
 * Round 14.6.4 final-sweep 2026-05-29 — empirical fix для prod bug caught via
 * curl on demo.sepshn.ru: oversized POST к `/api/_mock-ota/yandex/v1/search`
 * returned HTTP 500 instead of 413 because `app.onError(onError)` caught
 * `HTTPException` thrown by `hono/body-limit` middleware и dropped to the
 * "anything else → INTERNAL" fallback. Pre-fix RDR4/RDR5/RDR6 tests used
 * `registerDemoRoutes`-only apps без `app.onError` mounted, hiding the bug.
 *
 * This test pins onError precedence для each error class. [OE1] is THE pin
 * закрывающий тот prod bug — pre-fix → fail (returns 500); post-fix → 413.
 */

import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { AppEnv } from '../factory.ts'
import { NotFoundError } from './domain.ts'
import { onError } from './on-error.ts'

function buildApp() {
	const app = new Hono<AppEnv>()
	// Each test endpoint throws a different error class так onError precedence
	// can be exercised independently.
	app.get('/http-exception-413', () => {
		throw new HTTPException(413, {
			res: new Response('Payload Too Large', { status: 413 }),
		})
	})
	app.get('/http-exception-default-403', () => {
		// No explicit `res` — Hono builds the response from `message` + status.
		throw new HTTPException(403, { message: 'forbidden' })
	})
	app.get('/domain-error', () => {
		// NotFoundError = concrete DomainError subclass, code='NOT_FOUND' → 404.
		// (DomainError sам abstract — нельзя `new DomainError(...)` напрямую.)
		throw new NotFoundError('Property', 'prop_test')
	})
	app.get('/zod-error', () => {
		// Real ZodError from parse failure — avoids Zod-4-canary internal-shape
		// drift between manual `new ZodError([...])` construction и parsed
		// version. safeParse failure produces canonical error object.
		const schema = z.object({ requiredField: z.string() })
		const result = schema.safeParse({})
		if (result.success) throw new Error('unreachable')
		throw result.error
	})
	app.get('/raw-error', () => {
		throw new Error('something exploded')
	})
	app.onError(onError)
	return app
}

describe('onError — error-class precedence', () => {
	it('[OE1] HTTPException(413) → pass-through 413 (closes prod body-cap 500 bug)', async () => {
		const res = await buildApp().request('/http-exception-413')
		expect(res.status).toBe(413)
		const body = await res.text()
		expect(body).toBe('Payload Too Large')
	})

	it('[OE2] HTTPException(403, {message}) → 403 via Hono default body', async () => {
		const res = await buildApp().request('/http-exception-default-403')
		expect(res.status).toBe(403)
		// Hono's default HTTPException response carries the message as plain text.
		const body = await res.text()
		expect(body).toContain('forbidden')
	})

	it('[OE3] DomainError → mapped status + JSON envelope', async () => {
		const res = await buildApp().request('/domain-error')
		expect(res.status).toBe(404)
		const body = (await res.json()) as { error: { code: string; message: string } }
		expect(body.error.code).toBe('NOT_FOUND')
		expect(body.error.message).toContain('Property')
	})

	it('[OE4] ZodError → 500 INTERNAL (repo-row schema drift signal)', async () => {
		const res = await buildApp().request('/zod-error')
		expect(res.status).toBe(500)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('INTERNAL')
	})

	it('[OE5] raw Error → 500 INTERNAL fallback', async () => {
		const res = await buildApp().request('/raw-error')
		expect(res.status).toBe(500)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('INTERNAL')
	})
})
