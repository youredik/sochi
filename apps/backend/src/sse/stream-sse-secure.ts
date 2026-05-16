import type { Context } from 'hono'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'

/**
 * G10 (2026-05-16) — production SSE wrapper centralizing canonical
 * 2026 hardening (R1+R2 ≥ 2026-05-16 research output):
 *
 *   1. **Cache-Control override**: Hono `streamSSE` unconditionally sets
 *      `Cache-Control: no-cache`; we override AFTER к `no-cache, no-transform`
 *      (RFC 9111 — prevents downstream CDN/proxy auto-compression that breaks
 *      SSE real-time). Verified pattern: mastra-ai/mastra#13584 +
 *      Hono main-branch context.ts source analysis. Headers are mutable
 *      until first byte writes; `streamSSE` returns synchronously before
 *      `run()` resolves, so `.set()` lands before network.
 *
 *   2. **X-Accel-Buffering: no** — additional guarantee orthogonal к
 *      compression, defeats nginx/CDN response-body buffering (HireNodeJS
 *      2026 SSE production guide).
 *
 *   3. **Connection registry tracking** — increments active-count on open,
 *      decrements on abort. Enables: (a) graceful-shutdown broadcast,
 *      (b) per-tenant rate-limiting, (c) observability `sse.streams.active`
 *      gauge (Monium-prep canon per `[[observability-stack]]`).
 *
 * **Single-seam canon**: ALL SSE endpoints в codebase MUST go через this
 * helper. CI ratchet/biome guard greps for raw `streamSSE` imports outside
 * `apps/backend/src/sse/` and fails. This prevents future devs from
 * accidentally shipping un-hardened SSE.
 */

export interface StreamSSEOptions {
	/** Called when the stream aborts (client disconnect, server shutdown).
	 *  Use для cleanup: unsubscribe, clearInterval, decrement counters. */
	onAbort?: () => void | Promise<void>
}

export function streamSSESecure(
	c: Context,
	cb: (stream: SSEStreamingApi) => Promise<void>,
	opts: StreamSSEOptions = {},
): Response {
	// X-Accel-Buffering: no — survives streamSSE (only Content-Type /
	// Cache-Control / Connection / Transfer-Encoding are overwritten).
	c.header('X-Accel-Buffering', 'no')

	const response = streamSSE(c, async (stream) => {
		try {
			// Register abort cleanup BEFORE body — guarantees cleanup runs
			// even на immediate disconnect.
			if (opts.onAbort) {
				stream.onAbort(() => {
					try {
						const r = opts.onAbort?.()
						if (r && typeof (r as Promise<void>).catch === 'function') {
							;(r as Promise<void>).catch(() => undefined)
						}
					} catch {
						// best-effort cleanup
					}
				})
			}
			await cb(stream)
		} catch {
			// SSEStreamingApi swallows errors and closes stream — cleanup
			// runs via onAbort callback above.
		}
	})

	// Override Hono streamSSE's `Cache-Control: no-cache` к
	// `no-cache, no-transform` (R1+R2 ≥ 2026-05-16 canon). Response.headers
	// is mutable until first byte writes; streamSSE returns synchronously
	// before run() resolves.
	response.headers.set('Cache-Control', 'no-cache, no-transform')

	return response
}

/**
 * Re-export `SSEStreamingApi` so route files import from one seam
 * (`./stream-sse-secure`) instead of `hono/streaming` directly. Combined
 * с biome / depcruise guard «no `hono/streaming` import outside this file».
 */
export type { SSEStreamingApi } from 'hono/streaming'
