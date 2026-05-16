import { describe, expect, test } from 'bun:test'
import type { CdcEvent } from '../workers/cdc-handlers.ts'
import { createBookingSseCdcHandler, __internals } from './booking-cdc-projection.ts'
import { type BroadcastEvent, createBookingEventBroadcaster } from './booking-event-broadcaster.ts'

/**
 * G10 — strict tests для CDC projection: event-type mapping + identity
 * extraction + payload derivation + actor tagging.
 */

const TENANT = 'org_01HKQXR2T8J1QY7Q5W7K8R5K9P'
const PROP = 'prop_01HKQXR2T8J1QY7Q5W7K8R5K9P'
const BOOK = 'book_01HKQXR2T8J1QY7Q5W7K8R5K9P'

function ev(over: Partial<CdcEvent>): CdcEvent {
	return {
		key: [TENANT, PROP, '2030-01-01', BOOK],
		ts: [100, 1],
		...over,
	}
}

describe('deriveEventType', () => {
	test('INSERT (no old, has new) → booking.created', () => {
		expect(__internals.deriveEventType(ev({ newImage: { status: 'confirmed' } }))).toBe(
			'booking.created',
		)
	})

	test('DELETE (no new, has old) → booking.cancelled', () => {
		expect(__internals.deriveEventType(ev({ oldImage: { status: 'confirmed' } }))).toBe(
			'booking.cancelled',
		)
	})

	test('UPDATE с status transition к cancelled → booking.cancelled', () => {
		expect(
			__internals.deriveEventType(
				ev({
					oldImage: { status: 'confirmed' },
					newImage: { status: 'cancelled' },
				}),
			),
		).toBe('booking.cancelled')
	})

	test('UPDATE без status transition → booking.updated', () => {
		expect(
			__internals.deriveEventType(
				ev({
					oldImage: { status: 'confirmed', guestsCount: 1 },
					newImage: { status: 'confirmed', guestsCount: 2 },
				}),
			),
		).toBe('booking.updated')
	})

	test('UPDATE с status unchanged "cancelled→cancelled" → booking.updated (not re-cancel)', () => {
		expect(
			__internals.deriveEventType(
				ev({
					oldImage: { status: 'cancelled' },
					newImage: { status: 'cancelled', cancellationFeeMicros: 1n },
				}),
			),
		).toBe('booking.updated')
	})

	test('reset / unknown shape → null (no event emitted)', () => {
		expect(__internals.deriveEventType(ev({ reset: {} }))).toBeNull()
		expect(__internals.deriveEventType(ev({}))).toBeNull()
	})
})

describe('derivePayload', () => {
	test('extracts bookingId from key[3], non-PK from newImage', () => {
		const p = __internals.derivePayload(
			ev({
				newImage: {
					status: 'confirmed',
					channelCode: 'walkIn',
					externalId: 'B-9001',
					updatedBy: 'usr_alice',
				},
			}),
		)
		expect(p).toEqual({
			bookingId: BOOK,
			channelCode: 'walkIn',
			status: 'confirmed',
			externalId: 'B-9001',
			actorUserId: 'usr_alice',
		})
	})

	test('falls back к createdBy when updatedBy absent (INSERT case)', () => {
		const p = __internals.derivePayload(
			ev({
				newImage: {
					status: 'confirmed',
					channelCode: 'bnovo',
					createdBy: 'channel:bnovo',
				},
			}),
		)
		expect(p?.actorUserId).toBe('channel:bnovo')
	})

	test('fallback к "system:cdc" when neither updatedBy nor createdBy present', () => {
		const p = __internals.derivePayload(
			ev({ newImage: { status: 'confirmed', channelCode: 'walkIn' } }),
		)
		expect(p?.actorUserId).toBe('system:cdc')
	})

	test('null externalId when not present', () => {
		const p = __internals.derivePayload(
			ev({ newImage: { status: 'confirmed', channelCode: 'walkIn' } }),
		)
		expect(p?.externalId).toBeNull()
	})

	test('returns null когда bookingId prefix wrong (security probe)', () => {
		const p = __internals.derivePayload(
			ev({
				key: [TENANT, PROP, '2030-01-01', 'rmt_wrong_prefix'],
				newImage: { status: 'confirmed', channelCode: 'walkIn' },
			}),
		)
		expect(p).toBeNull()
	})

	test('returns null когда status or channelCode missing', () => {
		expect(__internals.derivePayload(ev({ newImage: { status: 'confirmed' } }))).toBeNull()
		expect(__internals.derivePayload(ev({ newImage: { channelCode: 'walkIn' } }))).toBeNull()
	})
})

describe('createBookingSseCdcHandler — full projection', () => {
	test('publishes correct event к broadcaster keyed by propertyId', async () => {
		const broadcaster = createBookingEventBroadcaster()
		const got: BroadcastEvent[] = []
		broadcaster.subscribe(PROP, (e) => {
			got.push(e)
		})
		const handler = createBookingSseCdcHandler(broadcaster)
		await handler({} as never, ev({ newImage: { status: 'confirmed', channelCode: 'walkIn' } }))
		expect(got).toHaveLength(1)
		expect(got[0]?.type).toBe('booking.created')
		// Narrow union: known booking.* event → SseBookingEventPayload shape.
		const payload = got[0]?.payload as { bookingId: string }
		expect(payload.bookingId).toBe(BOOK)
		expect(got[0]?.virtualTimestamp).toEqual([100, 1])
	})

	test('does not publish для wrong propertyId prefix', async () => {
		const broadcaster = createBookingEventBroadcaster()
		const got: BroadcastEvent[] = []
		broadcaster.subscribe('rmt_bad', (e) => {
			got.push(e)
		})
		const handler = createBookingSseCdcHandler(broadcaster)
		await handler(
			{} as never,
			ev({
				key: [TENANT, 'rmt_bad', '2030-01-01', BOOK],
				newImage: { status: 'confirmed', channelCode: 'walkIn' },
			}),
		)
		expect(got).toHaveLength(0)
	})

	test('does not publish без ts (no virtual timestamp)', async () => {
		const broadcaster = createBookingEventBroadcaster()
		const got: BroadcastEvent[] = []
		broadcaster.subscribe(PROP, (e) => {
			got.push(e)
		})
		const handler = createBookingSseCdcHandler(broadcaster)
		// ts is optional in CdcEvent shape; spread без ts simulates missing-ts CDC event.
		const eventWithoutTs: import('../workers/cdc-handlers.ts').CdcEvent = {
			key: [TENANT, PROP, '2030-01-01', BOOK],
			newImage: { status: 'confirmed', channelCode: 'walkIn' },
		}
		await handler({} as never, eventWithoutTs)
		expect(got).toHaveLength(0)
	})
})
