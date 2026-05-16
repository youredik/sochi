import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { streamSSESecure } from './stream-sse-secure.ts'

/**
 * G10 — empirical verification that `streamSSESecure` overrides Hono's
 * default `Cache-Control: no-cache` к `no-cache, no-transform` per R1+R2
 * ≥ 2026-05-16 canon. Plus X-Accel-Buffering: no header.
 */

describe('streamSSESecure — response header canon', () => {
	test('overrides Cache-Control к "no-cache, no-transform" (defeats CDN/proxy auto-gzip)', async () => {
		const app = new Hono().get('/sse', (c) =>
			streamSSESecure(c, async (stream) => {
				await stream.writeSSE({ data: 'hello', event: 'test' })
			}),
		)
		const res = await app.request('/sse')
		expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform')
	})

	test('preserves X-Accel-Buffering: no (defeats nginx response buffering)', async () => {
		const app = new Hono().get('/sse', (c) =>
			streamSSESecure(c, async (stream) => {
				await stream.writeSSE({ data: 'hello', event: 'test' })
			}),
		)
		const res = await app.request('/sse')
		expect(res.headers.get('X-Accel-Buffering')).toBe('no')
	})

	test('preserves Hono-set Content-Type: text/event-stream', async () => {
		const app = new Hono().get('/sse', (c) =>
			streamSSESecure(c, async (stream) => {
				await stream.writeSSE({ data: 'hello', event: 'test' })
			}),
		)
		const res = await app.request('/sse')
		expect(res.headers.get('Content-Type')).toBe('text/event-stream')
	})

	test('preserves Connection: keep-alive', async () => {
		const app = new Hono().get('/sse', (c) =>
			streamSSESecure(c, async (stream) => {
				await stream.writeSSE({ data: 'hello', event: 'test' })
			}),
		)
		const res = await app.request('/sse')
		expect(res.headers.get('Connection')).toBe('keep-alive')
	})

	test('calls onAbort cleanup callback when stream cancelled', async () => {
		let cleanupRan = false
		const app = new Hono().get('/sse', (c) =>
			streamSSESecure(
				c,
				async (stream) => {
					await stream.writeSSE({ data: 'hello', event: 'test' })
					// Hold open — caller's reader will cancel ниже
					await new Promise<void>((resolve) => stream.onAbort(resolve))
				},
				{
					onAbort: () => {
						cleanupRan = true
					},
				},
			),
		)
		const res = await app.request('/sse')
		const reader = res.body?.getReader()
		if (!reader) throw new Error('no body reader')
		await reader.read() // consume first chunk
		await reader.cancel()
		// Microtask flush для cleanup callback
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(cleanupRan).toBe(true)
	})
})
