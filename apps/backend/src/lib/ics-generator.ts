/**
 * `.ics` calendar invite generator (M9.widget.5 — Track A3 / A3.1.a).
 *
 * Per `plans/m9_widget_5_canonical.md` §D8:
 *   - `ical-generator@10.2.0` (active 2026-04-17) — replaces stale ics@3.x
 *     (no native VTIMEZONE) — Outlook strict-mode safe
 *   - `timezones-ical-library@2.2.0` (active 2026-04-29) — VTIMEZONE companion;
 *     replaces @touch4it/ical-timezones (STALE 2.5y, code frozen 2023-01)
 *
 * VEVENT canonical для booking voucher (RFC 5545):
 *   - METHOD:PUBLISH (informational, not RSVP — booking already confirmed)
 *   - UID = `<bookingReference>@<tenantDomain>` (stable cross-client)
 *   - DTSTART/DTEND с TZID=Europe/Moscow + VTIMEZONE block (Сочи UTC+3, no DST since 2014)
 *   - SUMMARY/LOCATION UTF-8 cyrillic native (RFC 5545 §6 — UTF-8 mandate)
 *   - Filename ASCII-only (`booking-<ref>.ics` — RFC 6266 для cross-client mobile)
 *
 * Output: `{ filename, content, contentType }` ready для SES v2 Attachments
 * shape OR HTTP `Content-Disposition: attachment` response.
 */

import ical, { ICalCalendarMethod } from 'ical-generator'
import { tzlib_get_ical_block } from 'timezones-ical-library'

const HOTEL_TIMEZONE = 'Europe/Moscow' as const

export interface BookingIcsInput {
	readonly bookingReference: string
	readonly tenantDomain: string /** e.g. 'sirius.sochi.app' */
	readonly propertyName: string
	readonly propertyAddress: string
	readonly checkInLocal: Date /** wall-time at hotel — interpreted в Europe/Moscow */
	readonly checkOutLocal: Date
	readonly organizerEmail: string /** noreply@<tenant>.<domain> */
}

export interface IcsAttachment {
	readonly filename: string
	readonly content: string /** RFC 5545 raw text */
	readonly contentType: string /** 'text/calendar; method=PUBLISH; charset=utf-8' */
}

/**
 * Generate booking confirmation .ics attachment.
 *
 * Cross-client compat verified per ical-generator 10.2.0 + timezones-ical-library
 * 2.2.0 — Outlook strict-mode + Apple Calendar + Google Calendar + Yandex
 * Calendar (.ics import only, no public deeplink URL pattern documented).
 */
export function generateBookingIcs(input: BookingIcsInput): IcsAttachment {
	const cal = ical({
		name: `Бронь №${input.bookingReference}`,
		method: ICalCalendarMethod.PUBLISH,
		prodId: { company: 'Sochi HoReCa', product: 'booking-widget' },
		timezone: {
			name: HOTEL_TIMEZONE,
			generator: (tz: string) => {
				const block = tzlib_get_ical_block(tz)
				if (!block || block.length === 0) {
					throw new Error(`timezones-ical-library returned no VTIMEZONE for ${tz}`)
				}
				return block[0] as string
			},
		},
	})

	cal.createEvent({
		id: `${input.bookingReference}@${input.tenantDomain}`,
		start: input.checkInLocal,
		end: input.checkOutLocal,
		timezone: HOTEL_TIMEZONE,
		summary: `Бронь №${input.bookingReference} — ${input.propertyName}`,
		location: input.propertyAddress,
		description: 'Заезд после 14:00, выезд до 12:00.',
		organizer: { name: input.propertyName, email: input.organizerEmail },
	})

	return {
		filename: `booking-${input.bookingReference}.ics`,
		content: cal.toString(),
		contentType: 'text/calendar; method=PUBLISH; charset=utf-8',
	}
}
