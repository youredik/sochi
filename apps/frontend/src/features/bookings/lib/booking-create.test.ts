import { describe, expect, it } from 'vitest'
import {
	type BookingCreateDialogInput,
	buildBookingCreateBody,
	buildGuestCreateBody,
	buildGuestSnapshot,
	defaultCheckOut,
	generateIdempotencyKey,
	nightsCount,
} from './booking-create.ts'

const baseGuest: BookingCreateDialogInput['primaryGuest'] = {
	firstName: 'Иван',
	lastName: 'Иванов',
	middleName: 'Иванович',
	citizenship: 'RU',
	documentType: 'Паспорт РФ',
	documentNumber: '4510123456',
}

const baseInput: BookingCreateDialogInput = {
	roomTypeId: 'rmt_abc',
	ratePlanId: 'rp_bar',
	checkIn: '2026-05-01',
	checkOut: '2026-05-04',
	guestsCount: 2,
	primaryGuestId: 'guest_xyz',
	primaryGuest: baseGuest,
}

describe('buildGuestSnapshot — immutable subset', () => {
	it('copies exactly the 6 МВД-required fields', () => {
		const snap = buildGuestSnapshot(baseGuest)
		expect(snap).toEqual({
			firstName: 'Иван',
			lastName: 'Иванов',
			middleName: 'Иванович',
			citizenship: 'RU',
			documentType: 'Паспорт РФ',
			documentNumber: '4510123456',
		})
	})

	it('omits middleName when absent (optional field — snapshot must not carry empty string)', () => {
		const { middleName: _omit, ...rest } = baseGuest
		void _omit
		const snap = buildGuestSnapshot(rest)
		expect(snap).not.toHaveProperty('middleName')
		expect(snap.firstName).toBe('Иван')
	})

	it('omits middleName when explicitly null (Guest row default for unset)', () => {
		const snap = buildGuestSnapshot({ ...baseGuest, middleName: null })
		expect(snap).not.toHaveProperty('middleName')
	})

	it('omits middleName when empty-string (trimmed guests never have bare empty in snapshot)', () => {
		const snap = buildGuestSnapshot({ ...baseGuest, middleName: '' })
		expect(snap).not.toHaveProperty('middleName')
	})

	it('pure — same input yields deep-equal output (no mutation of caller)', () => {
		const a = buildGuestSnapshot(baseGuest)
		const b = buildGuestSnapshot(baseGuest)
		expect(a).toEqual(b)
		// Source object must be untouched.
		expect(baseGuest.firstName).toBe('Иван')
	})
})

describe('buildBookingCreateBody — wire contract', () => {
	it('assembles all 8 server-required fields with defaults', () => {
		const body = buildBookingCreateBody(baseInput)
		expect(body).toEqual({
			roomTypeId: 'rmt_abc',
			ratePlanId: 'rp_bar',
			checkIn: '2026-05-01',
			checkOut: '2026-05-04',
			guestsCount: 2,
			primaryGuestId: 'guest_xyz',
			guestSnapshot: {
				firstName: 'Иван',
				lastName: 'Иванов',
				middleName: 'Иванович',
				citizenship: 'RU',
				documentType: 'Паспорт РФ',
				documentNumber: '4510123456',
			},
			channelCode: 'walkIn',
		})
	})

	it('channelCode "direct" passed through (front-desk vs booking engine)', () => {
		const body = buildBookingCreateBody({ ...baseInput, channelCode: 'direct' })
		expect(body.channelCode).toBe('direct')
	})

	it('channelCode defaults to "walkIn" when omitted (dialog origin assumption)', () => {
		const body = buildBookingCreateBody(baseInput)
		expect(body.channelCode).toBe('walkIn')
	})

	it('notes included only when non-empty', () => {
		const withNotes = buildBookingCreateBody({ ...baseInput, notes: 'VIP, без алкоголя' })
		expect(withNotes.notes).toBe('VIP, без алкоголя')
		const noNotes = buildBookingCreateBody(baseInput)
		expect(noNotes).not.toHaveProperty('notes')
	})

	describe('adversarial — date invariants', () => {
		it('rejects checkIn == checkOut (0 nights is invalid)', () => {
			expect(() =>
				buildBookingCreateBody({ ...baseInput, checkIn: '2026-05-01', checkOut: '2026-05-01' }),
			).toThrow(/strictly before/)
		})

		it('rejects checkIn > checkOut (reversed dates)', () => {
			expect(() =>
				buildBookingCreateBody({ ...baseInput, checkIn: '2026-05-05', checkOut: '2026-05-01' }),
			).toThrow(/strictly before/)
		})
	})

	describe('adversarial — guestsCount invariants', () => {
		it.each([
			[0, 'zero'],
			[-1, 'negative'],
			[21, 'past max'],
			[1.5, 'fractional'],
			[Number.NaN, 'NaN'],
			[Number.POSITIVE_INFINITY, 'Infinity'],
		])('rejects guestsCount=%s (%s)', (count) => {
			expect(() => buildBookingCreateBody({ ...baseInput, guestsCount: count })).toThrow(
				/integer 1\.\.20/,
			)
		})

		it('accepts boundary 1 and 20', () => {
			expect(() => buildBookingCreateBody({ ...baseInput, guestsCount: 1 })).not.toThrow()
			expect(() => buildBookingCreateBody({ ...baseInput, guestsCount: 20 })).not.toThrow()
		})
	})
})

describe('buildGuestCreateBody — guest POST wire', () => {
	it('assembles 5 required fields (RU path, no visa)', () => {
		const body = buildGuestCreateBody({
			firstName: 'Пётр',
			lastName: 'Сидоров',
			citizenship: 'RU',
			documentType: 'Паспорт РФ',
			documentNumber: '4620111222',
		})
		expect(body).toEqual({
			firstName: 'Пётр',
			lastName: 'Сидоров',
			citizenship: 'RU',
			documentType: 'Паспорт РФ',
			documentNumber: '4620111222',
		})
		expect(body).not.toHaveProperty('middleName')
	})

	it('trims leading/trailing whitespace (adversarial paste from clipboard)', () => {
		const body = buildGuestCreateBody({
			firstName: '  Иван  ',
			lastName: '\tИванов\n',
			middleName: ' Иванович ',
			citizenship: 'RU',
			documentType: 'Паспорт РФ',
			documentNumber: ' 4510123456 ',
		})
		expect(body.firstName).toBe('Иван')
		expect(body.lastName).toBe('Иванов')
		expect(body.middleName).toBe('Иванович')
		expect(body.documentNumber).toBe('4510123456')
	})

	it('omits middleName when only-whitespace (doesn\'t save "   ")', () => {
		const body = buildGuestCreateBody({
			firstName: 'Иван',
			lastName: 'Иванов',
			middleName: '   ',
			citizenship: 'RU',
			documentType: 'Паспорт РФ',
			documentNumber: '4510123456',
		})
		expect(body).not.toHaveProperty('middleName')
	})

	describe('adversarial — required-field rejection', () => {
		it('rejects empty firstName', () => {
			expect(() =>
				buildGuestCreateBody({
					firstName: '   ',
					lastName: 'Иванов',
					citizenship: 'RU',
					documentType: 'Паспорт РФ',
					documentNumber: '4510123456',
				}),
			).toThrow(/firstName required/)
		})

		it('rejects empty lastName', () => {
			expect(() =>
				buildGuestCreateBody({
					firstName: 'Иван',
					lastName: '',
					citizenship: 'RU',
					documentType: 'Паспорт РФ',
					documentNumber: '4510123456',
				}),
			).toThrow(/lastName required/)
		})

		it('rejects whitespace-only documentNumber', () => {
			expect(() =>
				buildGuestCreateBody({
					firstName: 'Иван',
					lastName: 'Иванов',
					citizenship: 'RU',
					documentType: 'Паспорт РФ',
					documentNumber: '\t\t',
				}),
			).toThrow(/documentNumber required/)
		})
	})
})

describe('nightsCount', () => {
	it.each([
		['2026-05-01', '2026-05-02', 1],
		['2026-05-01', '2026-05-04', 3],
		['2026-05-01', '2026-05-31', 30],
		['2026-02-28', '2026-03-01', 1], // Feb→Mar crossing (2026 not leap)
		['2024-02-28', '2024-03-01', 2], // leap year — Feb 29 is a real night
	])('nightsCount(%s, %s) → %s', (ci, co, expected) => {
		expect(nightsCount(ci, co)).toBe(expected)
	})
})

describe('defaultCheckOut', () => {
	it('adds exactly 1 day', () => {
		expect(defaultCheckOut('2026-05-01')).toBe('2026-05-02')
	})

	it('handles month boundary', () => {
		expect(defaultCheckOut('2026-05-31')).toBe('2026-06-01')
	})

	it('handles year boundary', () => {
		expect(defaultCheckOut('2026-12-31')).toBe('2027-01-01')
	})
})

describe('generateIdempotencyKey', () => {
	it('returns a UUID v4 string (RFC 4122 §4.4 shape)', () => {
		const k = generateIdempotencyKey()
		expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
	})

	it('successive calls produce distinct keys (collision-free at N=1000)', () => {
		const set = new Set<string>()
		for (let i = 0; i < 1000; i++) set.add(generateIdempotencyKey())
		expect(set.size).toBe(1000)
	})
})
