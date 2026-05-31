import type {
	BookingChannelCode,
	BookingStatus,
	SseBookingEventPayload,
	SseEventType,
} from '@horeca/shared'
import type { TX } from '@ydbjs/query'
import { cdcStr, type CdcEvent } from '../workers/cdc-handlers.ts'
import type { BookingEventBroadcaster } from './booking-event-broadcaster.ts'

/**
 * G10 (2026-05-16) — CDC projection that fans booking changefeed events
 * out to SSE subscribers.
 *
 * Stateless projection — does NOT touch DB. Reads CDC event identity from
 * `event.key` (PK columns не репортятся в newImage/oldImage per YDB CDC
 * canon), reads non-PK fields from newImage (or oldImage on DELETE).
 *
 * Booking PK: `(tenantId, propertyId, checkIn, id)` →
 *   key[0]=tenantId, key[1]=propertyId, key[2]=checkIn, key[3]=id
 *
 * Event-type mapping:
 *   - INSERT (no oldImage, has newImage) → `booking.created`
 *   - UPDATE (both images) → `booking.updated` OR `booking.cancelled` если
 *     status transitioned к 'cancelled'
 *   - DELETE (no newImage, has oldImage) → `booking.cancelled` (rare —
 *     bookings normally don't hard-delete, but defensive)
 *
 * Idempotency: projection emits via broadcaster.publish() which is
 * synchronous + append-to-ring-buffer. Redelivery (at-least-once canon)
 * → duplicate publish → client receives duplicate event с same `id:`
 * (virtual timestamp). Client dedupes via id (queryClient.invalidateQueries
 * idempotent + Sonner toast id-based dedup canon D-G10.10).
 */

type CdcImage = Record<string, unknown>

function asString(v: unknown): string | null {
	if (v === null || v === undefined) return null
	if (typeof v === 'string') return v
	return cdcStr(v)
}

function deriveEventType(event: CdcEvent): SseEventType | null {
	const isInsert = !event.oldImage && !!event.newImage
	const isUpdate = !!event.oldImage && !!event.newImage
	const isDelete = !event.newImage && !!event.oldImage

	if (isInsert) return 'booking.created'
	if (isDelete) return 'booking.cancelled'
	if (isUpdate) {
		const newStatus = asString((event.newImage as CdcImage).status)
		const oldStatus = asString((event.oldImage as CdcImage).status)
		if (newStatus === 'cancelled' && oldStatus !== 'cancelled') return 'booking.cancelled'
		return 'booking.updated'
	}
	return null
}

function derivePayload(event: CdcEvent): SseBookingEventPayload | null {
	const key = event.key ?? []
	const bookingId = cdcStr(key[3])
	if (!bookingId.startsWith('book_')) return null

	const image = (event.newImage ?? event.oldImage ?? {}) as CdcImage
	const channelCode = asString(image.channelCode)
	const status = asString(image.status)
	if (!channelCode || !status) return null

	const externalId = asString(image.externalId)
	const actorRaw = asString(image.updatedBy) ?? asString(image.createdBy)
	const actorUserId = actorRaw && actorRaw.length > 0 ? actorRaw : 'system:cdc'

	return {
		bookingId,
		channelCode: channelCode as BookingChannelCode,
		status: status as BookingStatus,
		externalId,
		actorUserId,
	}
}

/**
 * Build a CDC projection function для `sse_booking_writer` consumer.
 *
 * NB: this projection is stateless и does NOT touch the tx. We keep
 * the `tx` parameter for signature compatibility с `startCdcConsumer`.
 * Publishing к broadcaster happens INSIDE the projection tx so that
 * tx rollback (rare: nothing to rollback here) would correlate с no-publish.
 * In practice: publish is idempotent, redelivery safe.
 */
export function createBookingSseCdcHandler(broadcaster: BookingEventBroadcaster) {
	return async function projection(_tx: TX, event: CdcEvent): Promise<void> {
		const eventType = deriveEventType(event)
		if (!eventType) return
		const payload = derivePayload(event)
		if (!payload) return
		const key = event.key ?? []
		const propertyId = cdcStr(key[1])
		if (!propertyId.startsWith('prop_')) return
		const ts = event.ts
		if (!ts || ts.length < 2) return
		broadcaster.publish(propertyId, {
			type: eventType,
			payload,
			virtualTimestamp: [ts[0] ?? 0, ts[1] ?? 0] as const,
			receivedAt: Date.now(),
		})
	}
}

/** Exposed для unit tests — pure projection without broadcaster. */
export const __internals = { deriveEventType, derivePayload }
