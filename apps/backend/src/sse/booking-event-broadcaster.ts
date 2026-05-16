import {
	SSE_RING_BUFFER_MAX,
	SSE_RING_BUFFER_MS,
	type SseBookingEventPayload,
	type SseEventType,
	type SseShutdownPayload,
	type SseStalePayload,
	compareSseEventIds,
	formatSseEventId,
} from '@horeca/shared'

/**
 * G10 (2026-05-16) — in-memory booking-event broadcaster + ring buffer.
 *
 * Per R1+R2 ≥ 2026-05-16 canon (D-G10.7, D-G10.9):
 *   - **Per-propertyId subscriber registry** — tenant isolation enforced
 *     at SSE handler (NOT at CDC consumer). One consumer reads ALL events;
 *     broadcaster filters per-property delivery.
 *   - **60s ring buffer per propertyId** for `Last-Event-ID` replay. On
 *     reconnect, client sends `Last-Event-ID: <vt.global>:<vt.txid>`; we
 *     replay all newer events from buffer THEN attach к live stream.
 *   - **Capped at SSE_RING_BUFFER_MAX events** per propertyId (noisy-tenant
 *     CPU defense per HireNodeJS 2026 SSE production canon).
 *
 * **Single-instance only.** Multi-replica backend deployment requires
 * a shared message bus (Redis Pub/Sub / NATS) OR per-instance consumers
 * with per-instance consumer-names. Documented в plan §G10 deployment notes.
 */

/**
 * BroadcastEvent payload is a discriminated union per event type:
 *   - `booking.*` → SseBookingEventPayload (domain event)
 *   - `stale` → SseStalePayload (lifecycle: queue overflow / buffer rotated)
 *   - `shutdown` → SseShutdownPayload (lifecycle: SIGTERM)
 *   - `ready` → never goes through broadcaster (route handler writes directly)
 *
 * Route wire-encoder reads `type` first и encodes payload accordingly.
 */
export type BroadcastEventPayload = SseBookingEventPayload | SseStalePayload | SseShutdownPayload

export interface BroadcastEvent {
	type: SseEventType
	payload: BroadcastEventPayload
	/** YDB CDC virtual timestamp `[global, txid]` — serializes к event-id.
	 *  Synthetic lifecycle events (shutdown) use `[Date.now(), 0]` for
	 *  ordering-by-arrival-time. */
	virtualTimestamp: readonly [number, number]
	/** Wall-clock ms when broadcaster received the event (для buffer expiry). */
	receivedAt: number
}

interface BufferEntry {
	event: BroadcastEvent
	expiresAt: number
}

/**
 * Subscriber callback. Throwing inside MUST NOT crash the broadcaster —
 * dispatcher catches per-subscriber and unregisters dead handles.
 */
export type Subscriber = (event: BroadcastEvent) => void | Promise<void>

/**
 * 3-state replay result per R2 ≥ 2026-05-16 canon (MCP spec issue #1939
 * + our pure-fn property-test canon). Caller (route handler) translates
 * к wire-protocol:
 *   - `replay` → flush events normally, then live-stream tap-in
 *   - `stale` → emit synthetic `event: stale\ndata: {"reason":"buffer_rotated"}`
 *     before live stream (client full-refetches)
 *   - `unknown` → same as stale (treat as fresh subscription); log warning
 *     for observability — sinceId never existed (different deploy / tenant)
 */
export type ReplayResult =
	| { kind: 'replay'; events: BroadcastEvent[] }
	| { kind: 'stale'; sinceId: readonly [number, number] }
	| { kind: 'unknown'; sinceId: readonly [number, number] }

export interface BookingEventBroadcaster {
	/** Register a subscriber; returns unregister fn (call in stream cleanup). */
	subscribe(propertyId: string, subscriber: Subscriber): () => void
	/** Fan-out domain event к all subscribers for propertyId + append к ring
	 *  buffer (for Last-Event-ID replay). USE для booking.* events. */
	publish(propertyId: string, event: BroadcastEvent): void
	/** Fan-out lifecycle event к all subscribers for propertyId WITHOUT adding
	 *  к ring buffer. USE для one-shot meta-events (shutdown, stale signals
	 *  that shouldn't replay after reconnect to a different backend instance). */
	publishEphemeral(propertyId: string, event: BroadcastEvent): void
	/** Get buffered events newer than `since` OR signal staleness/unknown.
	 *  Pure function — property-testable. */
	replay(propertyId: string, since: readonly [number, number]): ReplayResult
	/** Diagnostic only (for tests + observability) — current subscriber count. */
	subscriberCount(propertyId: string): number
	/** Total subscriber count across all properties (для graceful-shutdown
	 *  broadcast + observability `sse.streams.active` metric). */
	totalSubscriberCount(): number
	/** Iterate all (propertyId, subscriber) pairs — used by shutdown broadcaster. */
	forEachSubscriber(callback: (propertyId: string, subscriber: Subscriber) => void): void
}

export function createBookingEventBroadcaster(opts?: {
	bufferTtlMs?: number
	bufferMax?: number
	now?: () => number
}): BookingEventBroadcaster {
	const bufferTtlMs = opts?.bufferTtlMs ?? SSE_RING_BUFFER_MS
	const bufferMax = opts?.bufferMax ?? SSE_RING_BUFFER_MAX
	const now = opts?.now ?? Date.now

	const subscribers = new Map<string, Set<Subscriber>>()
	const buffers = new Map<string, BufferEntry[]>()

	// Fan-out к live subscribers. Defensive try/catch — one dead subscriber
	// must not block others. Async errors swallowed here (stream cleanup
	// handles transport errors separately).
	function dispatch(propertyId: string, event: BroadcastEvent) {
		const set = subscribers.get(propertyId)
		if (!set) return
		for (const sub of set) {
			try {
				const r = sub(event)
				if (r && typeof (r as Promise<void>).catch === 'function') {
					;(r as Promise<void>).catch(() => undefined)
				}
			} catch {
				// best-effort delivery
			}
		}
	}

	function pruneBuffer(propertyId: string, currentTime: number) {
		const buf = buffers.get(propertyId)
		if (!buf) return
		// Drop expired (oldest first — buffer is append-only chronological).
		while (buf.length > 0) {
			const first = buf[0]
			if (!first || first.expiresAt > currentTime) break
			buf.shift()
		}
		// Cap at bufferMax (drop oldest above limit).
		while (buf.length > bufferMax) buf.shift()
		if (buf.length === 0) buffers.delete(propertyId)
	}

	return {
		subscribe(propertyId, subscriber) {
			let set = subscribers.get(propertyId)
			if (!set) {
				set = new Set()
				subscribers.set(propertyId, set)
			}
			set.add(subscriber)
			return () => {
				const s = subscribers.get(propertyId)
				if (!s) return
				s.delete(subscriber)
				if (s.size === 0) subscribers.delete(propertyId)
			}
		},

		publish(propertyId, event) {
			const currentTime = now()
			pruneBuffer(propertyId, currentTime)

			// Append к ring buffer (domain events only — replayable).
			let buf = buffers.get(propertyId)
			if (!buf) {
				buf = []
				buffers.set(propertyId, buf)
			}
			buf.push({ event, expiresAt: currentTime + bufferTtlMs })
			if (buf.length > bufferMax) buf.shift()

			dispatch(propertyId, event)
		},

		publishEphemeral(propertyId, event) {
			// Skip buffer — lifecycle events (shutdown / synthetic stale)
			// shouldn't replay к later reconnects.
			dispatch(propertyId, event)
		},

		replay(propertyId, since): ReplayResult {
			const currentTime = now()
			pruneBuffer(propertyId, currentTime)
			const buf = buffers.get(propertyId)
			if (!buf || buf.length === 0) {
				// Empty buffer = no events seen yet for this property. Per
				// R2 canon: unknown (sinceId never existed для this deploy/
				// tenant). Client still full-refetches but log distinguishes.
				return { kind: 'unknown', sinceId: since }
			}
			const headVt = buf[0]?.event.virtualTimestamp
			if (headVt && compareSseEventIds(since, headVt) < 0) {
				// `since` predates oldest buffered event → buffer rotated past.
				return { kind: 'stale', sinceId: since }
			}
			// In-window: return events strictly newer than `since`.
			const events = buf
				.filter((entry) => compareSseEventIds(entry.event.virtualTimestamp, since) > 0)
				.map((entry) => entry.event)
			return { kind: 'replay', events }
		},

		subscriberCount(propertyId) {
			return subscribers.get(propertyId)?.size ?? 0
		},

		totalSubscriberCount() {
			let total = 0
			for (const set of subscribers.values()) total += set.size
			return total
		},

		forEachSubscriber(callback) {
			for (const [pid, set] of subscribers) {
				for (const sub of set) callback(pid, sub)
			}
		},
	}
}

/**
 * Helper для SSE handler — format BroadcastEvent into SSE-wire shape
 * (id / event / data lines). Returns `id` as canonical
 * `<vt.global>:<vt.txid>` (parseable by `Last-Event-ID` on reconnect).
 */
export function broadcastEventToSseFrame(event: BroadcastEvent): {
	id: string
	event: string
	data: string
} {
	return {
		id: formatSseEventId(event.virtualTimestamp),
		event: event.type,
		data: JSON.stringify(event.payload),
	}
}
