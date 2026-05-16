import { describe, expect, test } from 'bun:test'
import {
	compareSseEventIds,
	formatSseEventId,
	parseSseEventId,
	SSE_HEARTBEAT_MS,
	SSE_MAX_CONCURRENT_PER_TENANT,
	SSE_MAX_CONCURRENT_PER_USER,
	SSE_QUEUE_MAX,
	SSE_RETRY_MS,
	SSE_RING_BUFFER_MAX,
	SSE_RING_BUFFER_MS,
	SSE_SHUTDOWN_RECONNECT_MS,
	sseBookingEventPayload,
	sseEventTypeSchema,
	sseShutdownPayload,
	sseStalePayload,
} from './sse-protocol.ts'

/**
 * G10 — strict tests for SSE protocol per `[[strict-tests]]` canon:
 * exact-value boundaries, adversarial inputs, immutable enum contract.
 */
describe('sseEventTypeSchema — 6 frozen values (3 domain + 3 lifecycle)', () => {
	test('accepts canonical domain event types', () => {
		expect(sseEventTypeSchema.safeParse('booking.created').success).toBe(true)
		expect(sseEventTypeSchema.safeParse('booking.updated').success).toBe(true)
		expect(sseEventTypeSchema.safeParse('booking.cancelled').success).toBe(true)
	})

	test('accepts lifecycle event types (stale/shutdown/ready)', () => {
		expect(sseEventTypeSchema.safeParse('stale').success).toBe(true)
		expect(sseEventTypeSchema.safeParse('shutdown').success).toBe(true)
		expect(sseEventTypeSchema.safeParse('ready').success).toBe(true)
	})

	test('rejects unknown event types (immutable canon)', () => {
		expect(sseEventTypeSchema.safeParse('booking.deleted').success).toBe(false)
		expect(sseEventTypeSchema.safeParse('payment.created').success).toBe(false)
		expect(sseEventTypeSchema.safeParse('cache-stale').success).toBe(false) // renamed → stale
		expect(sseEventTypeSchema.safeParse('').success).toBe(false)
		expect(sseEventTypeSchema.safeParse(null).success).toBe(false)
	})
})

describe('sseBookingEventPayload — Zod schema', () => {
	const valid = {
		bookingId: 'book_01HKQXR2T8J1QY7Q5W7K8R5K9P',
		channelCode: 'walkIn' as const,
		status: 'confirmed' as const,
		externalId: 'B-1234',
		actorUserId: 'ses_01HKQXR2T8J1QY7Q5W7K8R5K9P',
	}

	test('accepts valid payload', () => {
		expect(sseBookingEventPayload.safeParse(valid).success).toBe(true)
	})

	test('accepts externalId=null (direct/walkIn booking без channel#)', () => {
		expect(sseBookingEventPayload.safeParse({ ...valid, externalId: null }).success).toBe(true)
	})

	test('accepts externalId omitted', () => {
		const { externalId: _omit, ...withoutExt } = valid
		expect(sseBookingEventPayload.safeParse(withoutExt).success).toBe(true)
	})

	test('rejects bogus bookingId prefix (security probe)', () => {
		expect(
			sseBookingEventPayload.safeParse({ ...valid, bookingId: 'rmt_01HKQXR2T8J1QY7Q5W7K8R5K9P' })
				.success,
		).toBe(false)
	})

	test('rejects empty actorUserId (must always tag origin)', () => {
		expect(sseBookingEventPayload.safeParse({ ...valid, actorUserId: '' }).success).toBe(false)
	})

	test('rejects unknown channelCode', () => {
		expect(sseBookingEventPayload.safeParse({ ...valid, channelCode: 'agoda' }).success).toBe(false)
	})

	test('rejects unknown status', () => {
		expect(sseBookingEventPayload.safeParse({ ...valid, status: 'pending' }).success).toBe(false)
	})
})

describe('sseStalePayload — 3 reasons (research-bound canon)', () => {
	test('accepts buffer_rotated / sinceid_unknown / queue_overflow', () => {
		expect(sseStalePayload.safeParse({ reason: 'buffer_rotated' }).success).toBe(true)
		expect(sseStalePayload.safeParse({ reason: 'sinceid_unknown' }).success).toBe(true)
		expect(sseStalePayload.safeParse({ reason: 'queue_overflow' }).success).toBe(true)
	})

	test('rejects unknown reason', () => {
		expect(sseStalePayload.safeParse({ reason: 'network' }).success).toBe(false)
		expect(sseStalePayload.safeParse({ reason: 'ring-buffer-expired' }).success).toBe(false)
	})
})

describe('sseShutdownPayload', () => {
	test('accepts reconnectInMs in [0, 60000]', () => {
		expect(sseShutdownPayload.safeParse({ reconnectInMs: 0 }).success).toBe(true)
		expect(sseShutdownPayload.safeParse({ reconnectInMs: 1000 }).success).toBe(true)
		expect(sseShutdownPayload.safeParse({ reconnectInMs: 60_000 }).success).toBe(true)
	})

	test('rejects negative or >60s reconnectInMs', () => {
		expect(sseShutdownPayload.safeParse({ reconnectInMs: -1 }).success).toBe(false)
		expect(sseShutdownPayload.safeParse({ reconnectInMs: 60_001 }).success).toBe(false)
	})

	test('rejects non-integer (1.5 ms makes no sense)', () => {
		expect(sseShutdownPayload.safeParse({ reconnectInMs: 1.5 }).success).toBe(false)
	})
})

describe('format/parseSseEventId — Last-Event-ID round-trip', () => {
	test('formats virtual timestamp как `global:txid`', () => {
		expect(formatSseEventId([12345, 678])).toBe('12345:678')
	})

	test('round-trips через format → parse', () => {
		const original: [number, number] = [9876543210, 42]
		expect(parseSseEventId(formatSseEventId(original))).toEqual(original)
	})

	test('parse returns null on malformed (treats as no-replay — fresh subscribe)', () => {
		expect(parseSseEventId(null)).toBeNull()
		expect(parseSseEventId(undefined)).toBeNull()
		expect(parseSseEventId('')).toBeNull()
		expect(parseSseEventId('not-a-timestamp')).toBeNull()
		expect(parseSseEventId('12345')).toBeNull() // missing colon
		expect(parseSseEventId('a:b')).toBeNull() // non-numeric
		expect(parseSseEventId('12345:678:extra')).toBeNull() // too many parts
	})
})

describe('compareSseEventIds — order invariants', () => {
	test('returns negative when a before b в global step', () => {
		expect(compareSseEventIds([100, 5], [200, 5])).toBeLessThan(0)
	})

	test('returns positive when a after b в global step', () => {
		expect(compareSseEventIds([200, 5], [100, 5])).toBeGreaterThan(0)
	})

	test('uses txid as tiebreaker when global equal', () => {
		expect(compareSseEventIds([100, 5], [100, 10])).toBeLessThan(0)
		expect(compareSseEventIds([100, 10], [100, 5])).toBeGreaterThan(0)
	})

	test('returns 0 on equal', () => {
		expect(compareSseEventIds([100, 5], [100, 5])).toBe(0)
	})
})

describe('SSE timing constants — R2 ≥ 2026-05-16 bound canon', () => {
	test('heartbeat 25s survives nginx 60s + ALB 30s with margin (HireNodeJS 2026)', () => {
		expect(SSE_HEARTBEAT_MS).toBe(25_000)
	})

	test('retry 5s (gentler than browser-default 3s после outage)', () => {
		expect(SSE_RETRY_MS).toBe(5_000)
	})

	test('ring buffer 10 min (Commerce Layer canon refined for memory budget)', () => {
		expect(SSE_RING_BUFFER_MS).toBe(10 * 60_000)
	})

	test('ring buffer max 1000 events (~2MB/tenant × 100 active = 200MB headroom)', () => {
		expect(SSE_RING_BUFFER_MAX).toBe(1000)
	})

	test('per-connection queue cap 256 (5s headroom at 50 events/s burst)', () => {
		expect(SSE_QUEUE_MAX).toBe(256)
	})

	test('per-user/tenant SSE concurrent connection caps (DoS defense)', () => {
		expect(SSE_MAX_CONCURRENT_PER_USER).toBe(5)
		expect(SSE_MAX_CONCURRENT_PER_TENANT).toBe(50)
	})

	test('shutdown reconnect hint 1s (sse-starlette v3.4.4 canon)', () => {
		expect(SSE_SHUTDOWN_RECONNECT_MS).toBe(1_000)
	})
})
