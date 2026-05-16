import { zValidator } from '@hono/zod-validator'
import {
	SSE_HEARTBEAT_MS,
	SSE_QUEUE_MAX,
	SSE_RETRY_MS,
	SSE_SHUTDOWN_RECONNECT_MS,
	formatSseEventId,
	idSchema,
	parseSseEventId,
} from '@horeca/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../factory.ts'
import { authMiddleware } from '../middleware/auth.ts'
import { tenantMiddleware } from '../middleware/tenant.ts'
import type { PropertyService } from '../domains/property/property.service.ts'
import type { BookingEventBroadcaster, BroadcastEvent } from './booking-event-broadcaster.ts'
import { streamSSESecure } from './stream-sse-secure.ts'

/**
 * G10 (2026-05-16) — SSE real-time endpoint
 * `GET /api/v1/properties/:propertyId/events?stream=bookings`
 *
 * Per R1+R2 ≥ 2026-05-16 research output (D-G10.1..18 + research D-G10.x):
 *   - Auth via cookie ONLY (`withCredentials: true`) — EventSource spec
 *     disallows custom headers
 *   - Tenant scope: propertyService.getById(tenantId, propertyId) → 404
 *     если mismatch (NEVER silent downgrade)
 *   - Headers canonical via `streamSSESecure` single-seam wrapper
 *   - Heartbeat 25s: comment `:\n\n` (3 bytes, invisible to client)
 *   - Replay 3-state: `replay` → flush events; `stale|unknown` → synthetic
 *     `event: stale` then live stream
 *   - Queue overflow → synthetic `event: stale` (NOT silent drop —
 *     `[[silent-clamp-anti-pattern]]` canon)
 *   - Graceful shutdown: broadcaster emits `event: shutdown` к all
 *     active connections via `broadcastShutdown()` helper
 *
 * HTTP/2 vs HTTP/1.1: per research, run behind Yandex Cloud ALB (HTTP/2 к
 * client, HTTP/1.1 → backend). `Transfer-Encoding: chunked` (Hono streamSSE
 * default) is HTTP/1.1-only — ALB termination handles HTTP/2 upgrade.
 * Single-replica caveat: shared `sse_booking_writer` consumer-name means
 * only one instance owns partition в multi-replica deployment. Documented
 * в migration 0061.
 */

const propertyParam = z.object({ propertyId: idSchema('property') })
const streamQuery = z.object({
	stream: z.literal('bookings').optional(),
})

export function createSseRoutes(
	broadcaster: BookingEventBroadcaster,
	propertyService: PropertyService,
) {
	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.get(
			'/properties/:propertyId/events',
			zValidator('param', propertyParam),
			zValidator('query', streamQuery),
			async (c) => {
				const { propertyId } = c.req.valid('param')
				const tenantId = c.var.tenantId

				// Tenant gate: property must belong к tenant. 404 для wrong-
				// tenant per `[[strict-tests]]` security canon (NEVER silent
				// downgrade).
				const property = await propertyService.getById(tenantId, propertyId)
				if (!property) {
					return c.json({ error: { code: 'NOT_FOUND', message: 'Property not found' } }, 404)
				}

				const lastEventId = parseSseEventId(c.req.header('Last-Event-ID'))

				// Cleanup state captured here so onAbort can access it.
				let unsubscribe: (() => void) | null = null
				let heartbeatTimer: ReturnType<typeof setInterval> | null = null

				return streamSSESecure(
					c,
					async (stream) => {
						// Initial retry directive (D-G10.4). Gentler than browser-
						// default 3s after real outage.
						await stream.writeSSE({
							data: '',
							event: 'ready',
							retry: SSE_RETRY_MS,
						})

						// Replay 3-state per R2 canon (D-G10.9 + research):
						//   replay → flush events normally
						//   stale → buffer rotated past since-id → emit synthetic
						//   unknown → since-id never existed → same as stale + log
						if (lastEventId) {
							const result = broadcaster.replay(propertyId, lastEventId)
							if (result.kind === 'stale' || result.kind === 'unknown') {
								await stream.writeSSE({
									event: 'stale',
									data: JSON.stringify({
										reason: result.kind === 'stale' ? 'buffer_rotated' : 'sinceid_unknown',
									}),
								})
							} else {
								for (const ev of result.events) {
									await stream.writeSSE({
										id: formatSseEventId(ev.virtualTimestamp),
										event: ev.type,
										data: JSON.stringify(ev.payload),
									})
								}
							}
						}

						// Subscribe для live broadcast. Push events into queue —
						// decouples publish (sync, MUST not block CDC consumer)
						// from write (async). Bounded queue per R2 canon: cap=256;
						// overflow → synthetic `event: stale` к client (NOT silent
						// FIFO drop — `[[silent-clamp-anti-pattern]]` canon).
						const queue: BroadcastEvent[] = []
						let queueOverflowed = false
						let processing = false
						async function drain() {
							if (processing) return
							processing = true
							try {
								while (queue.length > 0) {
									if (queueOverflowed) {
										// Emit synthetic stale BEFORE next domain event
										// so client knows к full-refetch.
										await stream.writeSSE({
											event: 'stale',
											data: JSON.stringify({ reason: 'queue_overflow' }),
										})
										queueOverflowed = false
									}
									const ev = queue.shift()
									if (!ev) break
									await stream.writeSSE({
										id: formatSseEventId(ev.virtualTimestamp),
										event: ev.type,
										data: JSON.stringify(ev.payload),
									})
								}
							} catch {
								// Stream closed mid-write — cleanup runs via onAbort
							} finally {
								processing = false
							}
						}

						unsubscribe = broadcaster.subscribe(propertyId, (event) => {
							queue.push(event)
							if (queue.length > SSE_QUEUE_MAX) {
								queue.shift() // drop oldest
								queueOverflowed = true // sticky flag emits synthetic stale
							}
							void drain()
						})

						// Heartbeat loop (D-G10.3) — 25s comment line keeps proxies
						// от closing idle connection. Comment format: `:\n\n` invisible
						// к EventSource handlers, costs 3 bytes.
						heartbeatTimer = setInterval(() => {
							stream.write(':\n\n').catch(() => undefined)
						}, SSE_HEARTBEAT_MS)

						// Block until client disconnects (onAbort fires in wrapper).
						await new Promise<void>((resolve) => {
							stream.onAbort(resolve)
						})
					},
					{
						onAbort: () => {
							if (heartbeatTimer) {
								clearInterval(heartbeatTimer)
								heartbeatTimer = null
							}
							if (unsubscribe) {
								unsubscribe()
								unsubscribe = null
							}
						},
					},
				)
			},
		)
}

/**
 * Graceful-shutdown helper — broadcast `event: shutdown` к ALL active SSE
 * connections в registry. Called from SIGTERM handler (см. app.ts shutdown
 * sequence). Per sse-starlette v3.4.4 canon + OneUptime 2026 graceful-
 * shutdown guide: client reconnects к другой replica после `reconnectInMs`.
 *
 * Implementation: publish synthetic shutdown event с virtualTimestamp = now
 * к ring buffer для EACH propertyId с active subscribers. Subscribers
 * receive via existing fan-out path. Done synchronously — should complete
 * within K8s `terminationGracePeriodSeconds` (default 30s, our budget 25s).
 */
export function broadcastShutdown(
	broadcaster: BookingEventBroadcaster,
	reconnectInMs: number = SSE_SHUTDOWN_RECONNECT_MS,
): void {
	const propertiesWithSubs = new Set<string>()
	broadcaster.forEachSubscriber((propertyId) => propertiesWithSubs.add(propertyId))
	const ts = Date.now()
	for (const propertyId of propertiesWithSubs) {
		// publishEphemeral skips ring buffer — shutdown shouldn't replay
		// к future reconnects (they'd hit a different backend instance).
		broadcaster.publishEphemeral(propertyId, {
			type: 'shutdown',
			payload: { reconnectInMs },
			virtualTimestamp: [ts, 0] as const,
			receivedAt: ts,
		})
	}
}
