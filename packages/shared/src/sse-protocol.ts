import { z } from 'zod'
import { bookingChannelCodeSchema, bookingStatusSchema } from './booking.ts'
import { idSchema } from './schemas.ts'

/**
 * G10 (2026-05-16) — SSE event protocol between backend dispatcher and
 * frontend EventSource subscriber.
 *
 * R1+R2 ≥ 2026-05-16 research-agent canon decisions (D-G10.1..18):
 *   - Single endpoint `GET /properties/:propertyId/events?stream=bookings`
 *     с event-type routing via `event:` field (avoids 6-conn HTTP/1.1 cap)
 *   - Event ID format: `<vt.global>:<vt.txid>` per YDB CDC virtual timestamp
 *     (ordered resumption key)
 *   - Payload kept minimal — frontend invalidates queries to refetch full
 *     booking shape (avoids cache drift risk of `setQueryData`)
 *   - `actorUserId` tags origin session so own-session toasts can be
 *     suppressed client-side (prevent self-echo flash)
 *
 * Industry pattern: Cloudbeds/Apaleo/Bnovo/Hostaway/TravelLine use webhooks
 * (server→server only); Mews + OPERA Cloud use WebSocket. SSE chosen для
 * operator-app real-time because (a) server→client only — operator writes
 * via existing REST, (b) works через nginx/Yandex Cloud ALB без WS upgrade,
 * (c) browser-native EventSource auto-reconnect, no client lib.
 */

/** Top-level SSE event names. Keep small and frozen — adding event types
 *  breaks event-type-based filtering at client.
 *
 *  Per R1+R2 ≥ 2026-05-16 research output:
 *  - `booking.*` — domain events
 *  - `stale` — synthetic event signaling client к full-refetch (emitted
 *    on ring-buffer miss OR per-connection queue overflow per HireNodeJS
 *    2026 «no silent backpressure» + our `[[silent-clamp-anti-pattern]]`
 *    canon). MCP spec issue #1939 option 3: «SSE typed event с data payload».
 *  - `shutdown` — graceful-shutdown signal (SIGTERM): client reconnects
 *    after `reconnect_in_ms` к another replica. Per sse-starlette v3.4.4
 *    canon + OneUptime 2026 graceful-shutdown guide.
 *  - `ready` — initial frame meta-event (connection established). EventSource
 *    consumers can use это к clear «reconnecting» toast. */
const sseEventTypeValues = [
	'booking.created',
	'booking.updated',
	'booking.cancelled',
	'stale',
	'shutdown',
	'ready',
] as const
export const sseEventTypeSchema = z.enum(sseEventTypeValues)
export type SseEventType = z.infer<typeof sseEventTypeSchema>

/**
 * Booking event payload. Minimal — frontend uses `bookingId` к invalidate
 * + refetch the full row. `actorUserId` skipping = own-session
 * suppression (D-G10.10).
 */
export const sseBookingEventPayload = z.object({
	bookingId: idSchema('booking'),
	/** Channel of origin (per existing `Booking.channelCode`). Drives
	 *  toast sub-line («Bnovo» / «Островок» / «TravelLine» / «Прямое»). */
	channelCode: bookingChannelCodeSchema,
	/** Current booking status post-event. */
	status: bookingStatusSchema,
	/** Optional external code (channel-assigned reservation number) для
	 *  human-readable toast. Falls back к last-6 of `bookingId` when null. */
	externalId: z.string().min(1).max(100).nullable().optional(),
	/** User id who triggered the mutation. Plain userId для operator-
	 *  initiated changes; prefix-tagged ('system:cdc' / 'channel:bnovo' / ...)
	 *  для system/channel-originated changes. Frontend suppresses toast
	 *  если `actorUserId === currentUser.id` (avoid self-echo). Multi-tab
	 *  scenario: own user suppresses в ALL tabs — operator already saw
	 *  their write succeed via REST response. */
	actorUserId: z.string().min(1),
})
export type SseBookingEventPayload = z.infer<typeof sseBookingEventPayload>

/**
 * `stale` payload — emitted когда:
 *   - `buffer_rotated`: client reconnect Last-Event-ID predates ring buffer head
 *   - `sinceid_unknown`: Last-Event-ID never existed (different deploy / tenant)
 *   - `queue_overflow`: per-connection queue saturated, oldest events dropped
 *     (non-silent canon per `[[silent-clamp-anti-pattern]]` + `[[zero-price-
 *     data-loss-trap]]`)
 *
 * Client action на любую `stale`: full refetch of all booking queries.
 */
export const sseStalePayload = z.object({
	reason: z.enum(['buffer_rotated', 'sinceid_unknown', 'queue_overflow']),
})
export type SseStalePayload = z.infer<typeof sseStalePayload>

/**
 * `shutdown` payload — graceful SIGTERM signal. Client reconnects after
 * `reconnectInMs`. Per OneUptime 2026 graceful-shutdown canon + sse-starlette
 * v3.4.4 cooperative shutdown pattern.
 */
export const sseShutdownPayload = z.object({
	reconnectInMs: z.number().int().min(0).max(60_000),
})
export type SseShutdownPayload = z.infer<typeof sseShutdownPayload>

/**
 * Heartbeat interval — 25s. Survives nginx 60s + Yandex Cloud ALB 30s
 * defaults с margin (HireNodeJS 2026 SSE production canon vs OneUpTime
 * React 30s). Settle on 25s empirical sweet-spot.
 */
export const SSE_HEARTBEAT_MS = 25_000

/**
 * Initial `retry:` directive sent к client. EventSource default 3000ms;
 * 5000ms gentler on backend after real outage (HireNodeJS 2026 canon).
 */
export const SSE_RETRY_MS = 5_000

/**
 * Ring buffer retention для `Last-Event-ID` replay (per propertyId).
 * 10 minutes — per R2 ≥ 2026-05-16 research: covers laptop sleep / mobile-
 * network switch / long-lived reconnects (Commerce Layer Event Stream Hub
 * canon: 30 min wide; we tighten к 10 min для memory budget с 100+ tenants).
 * 1000 events × 2kB ≈ 2MB per active tenant × 100 active = ~200MB headroom
 * на 4GB Node process.
 */
export const SSE_RING_BUFFER_MS = 10 * 60_000

/**
 * Maximum events held в ring buffer per propertyId. Per R2 ≥ 2026-05-16:
 * 1000 events × 2kB worst-case JSON = 2MB/tenant; bounded against unlimited
 * memory growth.
 */
export const SSE_RING_BUFFER_MAX = 1000

/**
 * Per-connection backlog queue cap. Per R2 ≥ 2026-05-16: Telerik .NET 10
 * canon ships 100/DropOldest; our R2 prescribes **256** because Sochi
 * HoReCa multi-stream-per-tenant context может видеть 50 events/sec bursts
 * — 256 даёт ~5s buffer. 256 × 2kB = 512kB per connection × 1k concurrent
 * = 500MB worst-case (acceptable on 4GB Node).
 *
 * Overflow strategy: **drop oldest + emit synthetic `event: stale`** к
 * client (NOT silent FIFO drop per `[[silent-clamp-anti-pattern]]` canon).
 */
export const SSE_QUEUE_MAX = 256

/**
 * Per-tenant + per-user SSE connection limits (DoS defense). Per R2:
 * defends против hostile script opening 1000 SSE в loop. `hono-rate-limiter`
 * keyGenerator returns `org+user` composite. 429 на excess.
 */
export const SSE_MAX_CONCURRENT_PER_USER = 5
export const SSE_MAX_CONCURRENT_PER_TENANT = 50

/**
 * Reconnect-in-ms hint emitted с `event: shutdown`. 1s lets client reconnect
 * к another replica fast; не sufficient for thundering-herd protection but
 * matches sse-starlette v3.4.4 canon.
 */
export const SSE_SHUTDOWN_RECONNECT_MS = 1_000

/**
 * Canonical Last-Event-ID format. CDC virtual timestamp `[global, txid]`
 * tuple serialized as `global:txid`. Lexicographically sortable WITHIN
 * same global step.
 */
export function formatSseEventId(virtualTimestamp: readonly [number, number]): string {
	const [global, txid] = virtualTimestamp
	return `${global}:${txid}`
}

/**
 * Parse Last-Event-ID back into virtual timestamp tuple. Returns null
 * on malformed input (treats как «no replay» — fresh subscription).
 */
export function parseSseEventId(id: string | null | undefined): [number, number] | null {
	if (!id) return null
	const parts = id.split(':')
	if (parts.length !== 2) return null
	const g = Number(parts[0])
	const t = Number(parts[1])
	if (!Number.isFinite(g) || !Number.isFinite(t)) return null
	return [g, t]
}

/**
 * Compare two virtual timestamps — returns < 0 if a before b, > 0 if a
 * after b, 0 if equal. Used by ring buffer для filter events newer than
 * `Last-Event-ID`.
 */
export function compareSseEventIds(
	a: readonly [number, number],
	b: readonly [number, number],
): number {
	if (a[0] !== b[0]) return a[0] - b[0]
	return a[1] - b[1]
}
