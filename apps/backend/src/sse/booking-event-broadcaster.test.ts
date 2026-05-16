import { describe, expect, test } from 'bun:test'
import type { SseBookingEventPayload } from '@horeca/shared'
import {
	type BroadcastEvent,
	broadcastEventToSseFrame,
	createBookingEventBroadcaster,
} from './booking-event-broadcaster.ts'

/**
 * G10 — strict tests для in-memory broadcaster: tenant isolation +
 * ring buffer + subscribe/unsubscribe lifecycle.
 */

function makePayload(over: Partial<SseBookingEventPayload> = {}): SseBookingEventPayload {
	return {
		bookingId: 'book_01HKQXR2T8J1QY7Q5W7K8R5K9P',
		channelCode: 'walkIn',
		status: 'confirmed',
		externalId: null,
		actorUserId: 'usr_test',
		...over,
	}
}

function makeEvent(
	vt: [number, number],
	type: BroadcastEvent['type'] = 'booking.created',
	payloadOver: Partial<SseBookingEventPayload> = {},
): BroadcastEvent {
	return {
		type,
		payload: makePayload(payloadOver),
		virtualTimestamp: vt,
		receivedAt: Date.now(),
	}
}

describe('createBookingEventBroadcaster — subscribe/unsubscribe', () => {
	test('subscribe registers и unsubscribe removes', () => {
		const b = createBookingEventBroadcaster()
		const got: BroadcastEvent[] = []
		const off = b.subscribe('prop_A', (e) => {
			got.push(e)
		})
		expect(b.subscriberCount('prop_A')).toBe(1)
		off()
		expect(b.subscriberCount('prop_A')).toBe(0)
	})

	test('multiple subscribers receive same event', () => {
		const b = createBookingEventBroadcaster()
		const a: BroadcastEvent[] = []
		const c: BroadcastEvent[] = []
		b.subscribe('prop_A', (e) => {
			a.push(e)
		})
		b.subscribe('prop_A', (e) => {
			c.push(e)
		})
		const ev = makeEvent([100, 1])
		b.publish('prop_A', ev)
		expect(a).toEqual([ev])
		expect(c).toEqual([ev])
	})

	test('tenant isolation: prop_A subscriber does NOT see prop_B events', () => {
		const b = createBookingEventBroadcaster()
		const aEvents: BroadcastEvent[] = []
		const bEvents: BroadcastEvent[] = []
		b.subscribe('prop_A', (e) => {
			aEvents.push(e)
		})
		b.subscribe('prop_B', (e) => {
			bEvents.push(e)
		})
		b.publish('prop_A', makeEvent([100, 1]))
		b.publish('prop_B', makeEvent([100, 2]))
		expect(aEvents).toHaveLength(1)
		expect(bEvents).toHaveLength(1)
		expect(aEvents[0]?.virtualTimestamp).toEqual([100, 1])
		expect(bEvents[0]?.virtualTimestamp).toEqual([100, 2])
	})

	test('subscriber throw does NOT crash broadcaster — other subscribers still fire', () => {
		const b = createBookingEventBroadcaster()
		const ok: BroadcastEvent[] = []
		b.subscribe('prop_A', () => {
			throw new Error('boom')
		})
		b.subscribe('prop_A', (e) => {
			ok.push(e)
		})
		const ev = makeEvent([100, 1])
		// Must not throw
		b.publish('prop_A', ev)
		expect(ok).toEqual([ev])
	})

	test('async subscriber rejection does NOT crash broadcaster', async () => {
		const b = createBookingEventBroadcaster()
		const ok: BroadcastEvent[] = []
		b.subscribe('prop_A', async () => {
			throw new Error('async boom')
		})
		b.subscribe('prop_A', (e) => {
			ok.push(e)
		})
		b.publish('prop_A', makeEvent([100, 1]))
		// Microtask flush
		await Promise.resolve()
		expect(ok).toHaveLength(1)
	})
})

describe('replay — Last-Event-ID 3-state {replay|stale|unknown}', () => {
	test('kind=replay returns events strictly newer than since (in-window)', () => {
		const b = createBookingEventBroadcaster()
		b.publish('prop_A', makeEvent([100, 1]))
		b.publish('prop_A', makeEvent([100, 2]))
		b.publish('prop_A', makeEvent([200, 1]))
		const got = b.replay('prop_A', [100, 1])
		expect(got.kind).toBe('replay')
		if (got.kind !== 'replay') throw new Error('narrowing')
		expect(got.events.map((e) => e.virtualTimestamp)).toEqual([
			[100, 2],
			[200, 1],
		])
	})

	test('kind=replay с empty events когда since newer than all buffered (caught-up)', () => {
		const b = createBookingEventBroadcaster()
		b.publish('prop_A', makeEvent([100, 1]))
		const got = b.replay('prop_A', [200, 0])
		expect(got.kind).toBe('replay')
		if (got.kind !== 'replay') throw new Error('narrowing')
		expect(got.events).toEqual([])
	})

	test('kind=unknown когда buffer empty (no events для property — different deploy/tenant)', () => {
		const b = createBookingEventBroadcaster()
		const got = b.replay('prop_unknown', [0, 0])
		expect(got.kind).toBe('unknown')
		if (got.kind !== 'unknown') throw new Error('narrowing')
		expect(got.sinceId).toEqual([0, 0])
	})

	test('kind=stale когда since predates buffer head (events rotated out)', () => {
		let now = 1_000
		const b = createBookingEventBroadcaster({ now: () => now, bufferTtlMs: 100 })
		b.publish('prop_A', makeEvent([50, 1]))
		now += 200
		b.publish('prop_A', makeEvent([200, 1])) // pruning evicts [50,1]
		const got = b.replay('prop_A', [50, 1]) // since < buffer head
		expect(got.kind).toBe('stale')
		if (got.kind !== 'stale') throw new Error('narrowing')
		expect(got.sinceId).toEqual([50, 1])
	})

	test('ring buffer prunes expired events (mock clock)', () => {
		let now = 1_000
		const b = createBookingEventBroadcaster({ now: () => now, bufferTtlMs: 100 })
		b.publish('prop_A', makeEvent([100, 1]))
		// Pre-prune verification: query с since exactly = [100,1] should be replay
		// (head match, no newer events), не stale.
		const prePrune = b.replay('prop_A', [100, 1])
		expect(prePrune.kind).toBe('replay')
		now += 200
		b.publish('prop_A', makeEvent([200, 1])) // triggers prune of [100,1]
		// Post-prune middle-ground verification: since=[150,0] would be replay
		// if [100,1] still present (since > head [100,1]) and would return
		// [200,1]; but if prune worked, head is [200,1] and since [150,0]
		// predates it → stale. This dichotomy isolates prune behavior.
		const postPruneMiddle = b.replay('prop_A', [150, 0])
		expect(postPruneMiddle.kind).toBe('stale')
		// Post-prune head-match verification: since=[200,1] = new head → replay
		// (empty events because nothing newer).
		const postPruneHead = b.replay('prop_A', [200, 1])
		expect(postPruneHead.kind).toBe('replay')
		if (postPruneHead.kind !== 'replay') throw new Error('narrowing')
		expect(postPruneHead.events).toEqual([])
	})

	test('ring buffer capped at bufferMax (FIFO eviction)', () => {
		const b = createBookingEventBroadcaster({ bufferMax: 3 })
		b.publish('prop_A', makeEvent([100, 1]))
		b.publish('prop_A', makeEvent([100, 2]))
		b.publish('prop_A', makeEvent([100, 3]))
		b.publish('prop_A', makeEvent([100, 4])) // evicts [100,1]; head = [100,2]
		// since=[100,2] is exact head match (not predates) → replay
		const exact = b.replay('prop_A', [100, 2])
		expect(exact.kind).toBe('replay')
		if (exact.kind !== 'replay') throw new Error('narrowing')
		expect(exact.events.map((e) => e.virtualTimestamp)).toEqual([
			[100, 3],
			[100, 4],
		])
		// since=[100,1] predates head [100,2] → stale (events lost)
		const lost = b.replay('prop_A', [100, 1])
		expect(lost.kind).toBe('stale')
	})
})

describe('subscriber count + shutdown iteration helpers', () => {
	test('totalSubscriberCount aggregates across properties', () => {
		const b = createBookingEventBroadcaster()
		b.subscribe('prop_A', () => {})
		b.subscribe('prop_A', () => {})
		b.subscribe('prop_B', () => {})
		expect(b.totalSubscriberCount()).toBe(3)
	})

	test('forEachSubscriber visits ALL (propertyId, subscriber) pairs', () => {
		const b = createBookingEventBroadcaster()
		b.subscribe('prop_A', () => {})
		b.subscribe('prop_A', () => {})
		b.subscribe('prop_B', () => {})
		const visited: string[] = []
		b.forEachSubscriber((pid) => visited.push(pid))
		expect(visited.sort()).toEqual(['prop_A', 'prop_A', 'prop_B'])
	})

	test('memory-leak guard: subscribe N → unsubscribe N → totalSubscriberCount === 0', () => {
		const b = createBookingEventBroadcaster()
		const offFns = Array.from({ length: 100 }, (_, i) => b.subscribe(`prop_${i % 5}`, () => {}))
		expect(b.totalSubscriberCount()).toBe(100)
		for (const off of offFns) off()
		expect(b.totalSubscriberCount()).toBe(0)
	})
})

describe('broadcastEventToSseFrame — wire format', () => {
	test('produces canonical id / event / data fields', () => {
		const frame = broadcastEventToSseFrame(makeEvent([12345, 678], 'booking.created'))
		expect(frame.id).toBe('12345:678')
		expect(frame.event).toBe('booking.created')
		// data is JSON-stringified payload
		const parsed = JSON.parse(frame.data) as SseBookingEventPayload
		expect(parsed.bookingId).toBe('book_01HKQXR2T8J1QY7Q5W7K8R5K9P')
		expect(parsed.channelCode).toBe('walkIn')
	})
})
