/**
 * Guest portal repo (M9.widget.5 / A3.3).
 *
 * Read-only repo для guest-portal view endpoint. Encapsulates DB query per
 * `no-routes-to-db` architecture canon.
 *
 * `viewBooking(tenantId, bookingId)` resolves booking + property + total formatted
 * для guest-portal display. Returns null если booking missing OR cross-tenant.
 */

import type { sql as SQL } from '../../db/index.ts'

type SqlInstance = typeof SQL

export interface GuestPortalView {
	readonly bookingId: string
	readonly status: string
	readonly checkIn: Date
	readonly checkOut: Date
	readonly nights: number
	readonly guestsCount: number
	readonly totalFormatted: string
	readonly currency: string
	readonly propertyName: string
	readonly propertyAddress: string | null
	readonly propertyPhone: string | null
}

interface BookingRow {
	id: string
	status: string
	checkIn: Date
	checkOut: Date
	nights: number | bigint
	guestsCount: number | bigint
	totalMicros: number | bigint
	currency: string
	propertyId: string
}

interface PropertyRow {
	name: string
	address: string | null
	phone: string | null
}

export function createGuestPortalRepo(sql: SqlInstance) {
	return {
		async viewBooking(tenantId: string, bookingId: string): Promise<GuestPortalView | null> {
			const [bookingRows = []] = await sql<BookingRow[]>`
				SELECT id, status, checkIn, checkOut, nights, guestsCount, totalMicros, currency, propertyId
				FROM booking
				WHERE tenantId = ${tenantId} AND id = ${bookingId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const booking = bookingRows[0]
			if (!booking) return null

			const [propRows = []] = await sql<PropertyRow[]>`
				SELECT name, address, phone FROM property
				WHERE tenantId = ${tenantId} AND id = ${booking.propertyId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const property = propRows[0]
			if (!property) return null

			const totalRubles = (Number(booking.totalMicros) / 1_000_000).toLocaleString('ru-RU', {
				minimumFractionDigits: 2,
				maximumFractionDigits: 2,
			})
			const totalFormatted = `${totalRubles} ${booking.currency === 'RUB' ? '₽' : booking.currency}`

			return {
				bookingId: booking.id,
				status: booking.status,
				checkIn: booking.checkIn,
				checkOut: booking.checkOut,
				nights: Number(booking.nights),
				guestsCount: Number(booking.guestsCount),
				totalFormatted,
				currency: booking.currency,
				propertyName: property.name,
				propertyAddress: property.address,
				propertyPhone: property.phone,
			}
		},
	}
}

export type GuestPortalRepo = ReturnType<typeof createGuestPortalRepo>
