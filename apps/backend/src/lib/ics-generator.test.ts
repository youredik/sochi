/**
 * Strict tests для .ics calendar generator (M9.widget.5 / A3.1.a).
 *
 * Pure unit — node-ical round-trip parser для RFC 5545 compliance verification.
 *
 * Coverage matrix:
 *   ─── Shape + RFC 5545 compliance ─────────────────────────────
 *     [ICS1] generated content includes BEGIN:VCALENDAR + END:VCALENDAR
 *     [ICS2] METHOD:PUBLISH (not REQUEST — voucher informational)
 *     [ICS3] PRODID set to identifiable product string
 *     [ICS4] VTIMEZONE block для Europe/Moscow embedded (no DST)
 *     [ICS5] VEVENT с UID = `<bookingRef>@<tenantDomain>`
 *
 *   ─── Field fidelity ──────────────────────────────────────────
 *     [ICS6] Cyrillic SUMMARY rendered correctly (UTF-8 native, no escape mangle)
 *     [ICS7] LOCATION preserves Cyrillic verbatim
 *     [ICS8] DTSTART/DTEND с TZID=Europe/Moscow (not floating, not UTC)
 *     [ICS9] Multi-day event (check-in 14:00 → check-out next-day 12:00) shape
 *     [ICS10] Filename ASCII-only (booking-<ref>.ics, NOT кириллица)
 *
 *   ─── node-ical round-trip parser verify ──────────────────────
 *     [ICS11] node-ical parseICS round-trip preserves UID + start + end
 *     [ICS12] Round-trip preserves SUMMARY текст после parse
 *
 *   ─── contentType ──────────────────────────────────────────────
 *     [ICS13] contentType = 'text/calendar; method=PUBLISH; charset=utf-8'
 */

import * as nodeIcal from 'node-ical'
import { describe, expect, test } from 'vitest'
import { generateBookingIcs } from './ics-generator.ts'

const STANDARD_INPUT = {
	bookingReference: 'BK-2026-A1B2C3',
	tenantDomain: 'sirius.sochi.app',
	propertyName: 'Гостиница Сириус',
	propertyAddress: 'ул. Парусная, 1, Сириус, Сочи, Россия',
	checkInLocal: new Date('2026-06-15T14:00:00+03:00'),
	checkOutLocal: new Date('2026-06-16T12:00:00+03:00'),
	organizerEmail: 'noreply@sirius.sochi.app',
} as const

describe('ics-generator', () => {
	test('[ICS1] generated content includes VCALENDAR boundary', () => {
		const ics = generateBookingIcs(STANDARD_INPUT)
		expect(ics.content).toContain('BEGIN:VCALENDAR')
		expect(ics.content).toContain('END:VCALENDAR')
	})

	test('[ICS2] METHOD:PUBLISH (not REQUEST)', () => {
		const ics = generateBookingIcs(STANDARD_INPUT)
		expect(ics.content).toContain('METHOD:PUBLISH')
		expect(ics.content).not.toContain('METHOD:REQUEST')
	})

	test('[ICS3] PRODID set к identifiable product', () => {
		const ics = generateBookingIcs(STANDARD_INPUT)
		expect(ics.content).toMatch(/PRODID:.*Sochi HoReCa.*booking-widget/i)
	})

	test('[ICS4] VTIMEZONE block для Europe/Moscow embedded', () => {
		const ics = generateBookingIcs(STANDARD_INPUT)
		expect(ics.content).toContain('BEGIN:VTIMEZONE')
		expect(ics.content).toContain('TZID:Europe/Moscow')
		expect(ics.content).toContain('END:VTIMEZONE')
		// No DST since 2014 — Russia abolished. Should have STANDARD only.
		expect(ics.content).toContain('TZOFFSETFROM:+0300')
		expect(ics.content).toContain('TZOFFSETTO:+0300')
	})

	test('[ICS5] VEVENT с UID = bookingRef@tenantDomain', () => {
		const ics = generateBookingIcs(STANDARD_INPUT)
		expect(ics.content).toContain('UID:BK-2026-A1B2C3@sirius.sochi.app')
	})

	test('[ICS6] Cyrillic SUMMARY rendered correctly (UTF-8)', () => {
		const ics = generateBookingIcs(STANDARD_INPUT)
		expect(ics.content).toMatch(/SUMMARY[:;].*Бронь №BK-2026-A1B2C3.*Гостиница Сириус/)
	})

	test('[ICS7] LOCATION preserves Cyrillic verbatim', () => {
		const ics = generateBookingIcs(STANDARD_INPUT)
		expect(ics.content).toContain('Парусная')
		expect(ics.content).toContain('Сириус')
	})

	test('[ICS8] DTSTART/DTEND с TZID=Europe/Moscow', () => {
		const ics = generateBookingIcs(STANDARD_INPUT)
		expect(ics.content).toMatch(/DTSTART;TZID=Europe\/Moscow:20260615T140000/)
		expect(ics.content).toMatch(/DTEND;TZID=Europe\/Moscow:20260616T120000/)
	})

	test('[ICS9] Multi-day event check-in 14:00 → check-out 12:00 next day', () => {
		const ics = generateBookingIcs(STANDARD_INPUT)
		expect(ics.content).toMatch(/DTSTART;TZID=Europe\/Moscow:20260615T140000/)
		expect(ics.content).toMatch(/DTEND;TZID=Europe\/Moscow:20260616T120000/)
	})

	test('[ICS10] Filename ASCII-only (RFC 6266 mobile-safe)', () => {
		const ics = generateBookingIcs(STANDARD_INPUT)
		expect(ics.filename).toBe('booking-BK-2026-A1B2C3.ics')
		// eslint-disable-next-line no-control-regex
		expect(ics.filename).toMatch(/^[\x20-\x7e]+$/)
	})

	test('[ICS11] node-ical parseICS round-trip preserves UID + start + end', () => {
		const ics = generateBookingIcs(STANDARD_INPUT)
		const parsed = nodeIcal.parseICS(ics.content)
		const events = Object.values(parsed).filter(
			(e): e is NonNullable<typeof e> => e !== undefined && e.type === 'VEVENT',
		)
		expect(events).toHaveLength(1)
		const event = events[0]
		expect(event).toBeDefined()
		if (!event) throw new Error('VEVENT not parsed')
		expect((event as { uid: string }).uid).toBe('BK-2026-A1B2C3@sirius.sochi.app')
		const start = (event as { start: Date }).start
		const end = (event as { end: Date }).end
		expect(start).toBeInstanceOf(Date)
		expect(end).toBeInstanceOf(Date)
		// Wall-time 14:00 в Europe/Moscow = 11:00 UTC.
		expect(start.toISOString()).toBe('2026-06-15T11:00:00.000Z')
		expect(end.toISOString()).toBe('2026-06-16T09:00:00.000Z')
	})

	test('[ICS12] Round-trip preserves SUMMARY текст after parse', () => {
		const ics = generateBookingIcs(STANDARD_INPUT)
		const parsed = nodeIcal.parseICS(ics.content)
		const event = Object.values(parsed).find(
			(e): e is NonNullable<typeof e> => e !== undefined && e.type === 'VEVENT',
		) as { summary: string } | undefined
		expect(event).toBeDefined()
		expect(event?.summary).toContain('Бронь №BK-2026-A1B2C3')
		expect(event?.summary).toContain('Гостиница Сириус')
	})

	test('[ICS13] contentType canonical', () => {
		const ics = generateBookingIcs(STANDARD_INPUT)
		expect(ics.contentType).toBe('text/calendar; method=PUBLISH; charset=utf-8')
	})
})
