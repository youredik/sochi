/**
 * `booking-labels` strict tests per memory `feedback_strict_tests.md` +
 * `feedback_pre_done_audit.md` (FULL enum coverage).
 *
 * Test plan:
 *   statusBadgeConf — exact match for ALL 5 booking statuses (canonical):
 *     [SS1] confirmed   → label "Подтверждена" / variant "outline"
 *     [SS2] in_house    → label "Заселился"    / variant "default"
 *     [SS3] checked_out → label "Выехал"       / variant "secondary"
 *     [SS4] cancelled   → label "Отменена"     / variant "destructive"
 *     [SS5] no_show     → label "Не явился"    / variant "destructive"
 *
 *   statusBadgeConf — unknown fallback (defence-in-depth):
 *     [SU1] empty string → label '' / variant 'outline'
 *     [SU2] hypothetical future "pending" → label 'pending' / variant 'outline'
 *     [SU3] capitalised "CONFIRMED" → label 'CONFIRMED' / variant 'outline'
 *           (case-sensitive — no silent normalization)
 *
 *   channelLabel — happy path covering ALL 9 channels in @horeca/shared:
 *     [CC1..9] direct/walkIn/yandexTravel/ostrovok/travelLine/bnovo/
 *              bookingCom/expedia/airbnb → exact RU labels
 *
 *   channelLabel — unknown fallback:
 *     [CU1] unknown channel → raw code returned
 *
 *   Immutability:
 *     [I1] STATUS_LABEL config not mutated by repeated calls
 */
import { describe, expect, test } from 'vitest'
import { channelLabel, statusBadgeConf } from './booking-labels.ts'

describe('statusBadgeConf — exact match all 5 canonical statuses', () => {
	test('[SS1] confirmed', () => {
		expect(statusBadgeConf('confirmed')).toEqual({ label: 'Подтверждена', variant: 'outline' })
	})
	test('[SS2] in_house', () => {
		expect(statusBadgeConf('in_house')).toEqual({ label: 'Заселился', variant: 'default' })
	})
	test('[SS3] checked_out', () => {
		expect(statusBadgeConf('checked_out')).toEqual({ label: 'Выехал', variant: 'secondary' })
	})
	test('[SS4] cancelled', () => {
		expect(statusBadgeConf('cancelled')).toEqual({ label: 'Отменена', variant: 'destructive' })
	})
	test('[SS5] no_show', () => {
		expect(statusBadgeConf('no_show')).toEqual({ label: 'Не явился', variant: 'destructive' })
	})
})

describe('statusBadgeConf — unknown fallback (defence-in-depth)', () => {
	test('[SU1] empty string → label "" / outline', () => {
		expect(statusBadgeConf('')).toEqual({ label: '', variant: 'outline' })
	})
	test('[SU2] future "pending" → raw code / outline', () => {
		expect(statusBadgeConf('pending')).toEqual({ label: 'pending', variant: 'outline' })
	})
	test('[SU3] CONFIRMED uppercase NOT normalized → raw code', () => {
		expect(statusBadgeConf('CONFIRMED')).toEqual({ label: 'CONFIRMED', variant: 'outline' })
	})
})

describe('channelLabel — exact match all 9 canonical channels', () => {
	test('[CC1] direct → Прямая', () => {
		expect(channelLabel('direct')).toBe('Прямая')
	})
	test('[CC2] walkIn → Заходом', () => {
		expect(channelLabel('walkIn')).toBe('Заходом')
	})
	test('[CC3] yandexTravel → Яндекс.Путешествия', () => {
		expect(channelLabel('yandexTravel')).toBe('Яндекс.Путешествия')
	})
	test('[CC4] ostrovok → Островок', () => {
		expect(channelLabel('ostrovok')).toBe('Островок')
	})
	test('[CC5] travelLine → TravelLine', () => {
		expect(channelLabel('travelLine')).toBe('TravelLine')
	})
	test('[CC6] bnovo → Bnovo', () => {
		expect(channelLabel('bnovo')).toBe('Bnovo')
	})
	test('[CC7] bookingCom → Booking.com', () => {
		expect(channelLabel('bookingCom')).toBe('Booking.com')
	})
	test('[CC8] expedia → Expedia', () => {
		expect(channelLabel('expedia')).toBe('Expedia')
	})
	test('[CC9] airbnb → Airbnb', () => {
		expect(channelLabel('airbnb')).toBe('Airbnb')
	})
})

describe('channelLabel — unknown fallback', () => {
	test('[CU1] unknown "tripadvisor" → returns raw code', () => {
		expect(channelLabel('tripadvisor')).toBe('tripadvisor')
	})
	test('[CU2] empty string → empty string', () => {
		expect(channelLabel('')).toBe('')
	})
})

describe('booking-labels — immutability', () => {
	test('[I1] repeated calls produce equal but independent results', () => {
		const a = statusBadgeConf('confirmed')
		const b = statusBadgeConf('confirmed')
		expect(a).toEqual(b)
		// Mutating one must NOT bleed into the underlying config.
		a.label = 'MUTATED'
		expect(b.label).toBe('Подтверждена')
		// Re-query to confirm config still pristine.
		expect(statusBadgeConf('confirmed').label).toBe('Подтверждена')
	})
})
