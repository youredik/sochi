import type { RatePlan } from '@horeca/shared'
import { describe, expect, it } from 'vitest'
import {
	applyOptimisticBand,
	type BookingCreateDialogInput,
	buildBookingCreateBody,
	buildGuestCreateBody,
	buildGuestSnapshot,
	buildOptimisticBand,
	defaultCheckOut,
	generateIdempotencyKey,
	nightsCount,
	pickDefaultRatePlan,
	pluralNights,
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

describe('pluralNights — Russian morphology', () => {
	describe('singular "ночь" (mod10=1, excluding teens)', () => {
		it.each([1, 21, 31, 41, 51, 61, 71, 81, 91, 101, 121])('%d → ночь', (n) => {
			expect(pluralNights(n)).toBe('ночь')
		})
	})

	describe('few "ночи" (mod10 in 2-4, excluding teens)', () => {
		it.each([2, 3, 4, 22, 23, 24, 32, 103, 104, 122, 123])('%d → ночи', (n) => {
			expect(pluralNights(n)).toBe('ночи')
		})
	})

	describe('many "ночей" (mod10 0 or 5-9, OR teens 11-14)', () => {
		it.each([0, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 100, 105])('%d → ночей', (n) => {
			expect(pluralNights(n)).toBe('ночей')
		})

		it.each([
			11, 12, 13, 14, 111, 112, 113, 114, 211, 212, 213, 214,
		])('teens-exception: %d → ночей (NOT ночь/ночи)', (n) => {
			expect(pluralNights(n)).toBe('ночей')
		})
	})
})

describe('pickDefaultRatePlan — fallback chain', () => {
	const plan = (overrides: Partial<RatePlan>): RatePlan => ({
		id: overrides.id ?? 'rp_1',
		tenantId: 'tnt_1',
		propertyId: 'prop_1',
		roomTypeId: 'rmt_1',
		name: 'Базовый',
		code: 'BAR',
		isDefault: false,
		isRefundable: true,
		cancellationHours: 24,
		mealsIncluded: 'none',
		minStay: 1,
		maxStay: 365,
		currency: 'RUB',
		isActive: true,
		createdAt: '2026-04-24T00:00:00Z',
		updatedAt: '2026-04-24T00:00:00Z',
		...overrides,
	})

	it('returns null for empty list', () => {
		expect(pickDefaultRatePlan([])).toBeNull()
	})

	it('prefers isDefault=true + isActive=true over bare isActive plan', () => {
		const def = plan({ id: 'rp_def', isDefault: true, isActive: true })
		const extra = plan({ id: 'rp_extra', isDefault: false, isActive: true })
		expect(pickDefaultRatePlan([extra, def])?.id).toBe('rp_def')
		// Order-independent — same outcome with default first.
		expect(pickDefaultRatePlan([def, extra])?.id).toBe('rp_def')
	})

	it('falls back to first isActive plan when no isDefault exists', () => {
		const a = plan({ id: 'rp_a', isDefault: false, isActive: true })
		const b = plan({ id: 'rp_b', isDefault: false, isActive: true })
		expect(pickDefaultRatePlan([a, b])?.id).toBe('rp_a')
	})

	it('adversarial: inactive default NEVER wins — falls through to active non-default', () => {
		// Admin toggled off the default mid-transition. We must NOT submit
		// to an inactive plan (server would 409 or stale it).
		const inactiveDefault = plan({ id: 'rp_stale_def', isDefault: true, isActive: false })
		const activeExtra = plan({ id: 'rp_extra', isDefault: false, isActive: true })
		expect(pickDefaultRatePlan([inactiveDefault, activeExtra])?.id).toBe('rp_extra')
	})

	it('returns null when every plan is inactive (dialog submit must stay disabled)', () => {
		const allInactive = [
			plan({ id: 'rp_a', isActive: false }),
			plan({ id: 'rp_b', isDefault: true, isActive: false }),
		]
		expect(pickDefaultRatePlan(allInactive)).toBeNull()
	})
})

describe('buildOptimisticBand — pending placeholder shape', () => {
	it('produces exact band shape with pending_ prefixed id', () => {
		const band = buildOptimisticBand({
			idempotencyKey: 'abc-123',
			roomTypeId: 'rmt_x',
			checkIn: '2026-05-10',
			checkOut: '2026-05-12',
		})
		expect(band).toEqual({
			id: 'pending_abc-123',
			roomTypeId: 'rmt_x',
			status: 'confirmed',
			checkIn: '2026-05-10',
			checkOut: '2026-05-12',
		})
	})

	it('id carries the full idempotency key verbatim (e2e rollback sanity asserts this prefix)', () => {
		const uuid = '550e8400-e29b-41d4-a716-446655440000'
		const band = buildOptimisticBand({
			idempotencyKey: uuid,
			roomTypeId: 'rmt_x',
			checkIn: '2026-05-10',
			checkOut: '2026-05-11',
		})
		expect(band.id).toBe(`pending_${uuid}`)
		// Future regression: if someone truncates or hashes the key, the
		// e2e `.not.toMatch(/^pending_/)` assertion would still pass but
		// this unit test would fail loudly.
		expect(band.id).toMatch(/^pending_[0-9a-f-]{36}$/)
	})

	it('status is always "confirmed" (server default — grid band palette picks it up immediately)', () => {
		const band = buildOptimisticBand({
			idempotencyKey: 'k',
			roomTypeId: 'rmt_x',
			checkIn: '2026-05-10',
			checkOut: '2026-05-11',
		})
		expect(band.status).toBe('confirmed')
	})
})

describe('applyOptimisticBand — pure cache transform', () => {
	const existing = [
		{
			id: 'b1',
			roomTypeId: 'rmt_x',
			status: 'confirmed' as const,
			checkIn: '2026-05-01',
			checkOut: '2026-05-03',
		},
	]
	const newBand = {
		id: 'pending_xxx',
		roomTypeId: 'rmt_x',
		status: 'confirmed' as const,
		checkIn: '2026-05-10',
		checkOut: '2026-05-11',
	}

	it('appends the new band without losing existing ones', () => {
		const out = applyOptimisticBand(existing, newBand)
		expect(out).toHaveLength(2)
		expect(out[0]?.id).toBe('b1')
		expect(out[1]?.id).toBe('pending_xxx')
	})

	it('pure: does not mutate the input array (React Query structural sharing safety)', () => {
		const lenBefore = existing.length
		const firstRef = existing[0]
		applyOptimisticBand(existing, newBand)
		expect(existing).toHaveLength(lenBefore)
		// Reference identity preserved on the element we didn't touch.
		expect(existing[0]).toBe(firstRef)
	})

	it('empty previous → result is just [band]', () => {
		const out = applyOptimisticBand([], newBand)
		expect(out).toEqual([newBand])
	})
})
