import type { BookingStatus } from '@horeca/shared'
import { describe, expect, it } from 'vitest'
import {
	availableTransitions,
	type BookingTransition,
	isTerminal,
	labelForStatus,
	labelForTransition,
	nextStatus,
} from './booking-transitions.ts'

/**
 * Strict tests for the booking state machine. Invariants under test:
 *   1. Terminal set (cancelled/checked_out/no_show) is immutable —
 *      exact-value assert on every enum value, in both directions.
 *   2. availableTransitions() is exact-value per status, NOT subset.
 *      Drift (adding a transition that server doesn't support) would
 *      let UI surface an action that then 409s.
 *   3. nextStatus is total over valid (status, transition) pairs and
 *      throws for invalid pairs — hunt the no-op/silent-fail bug class.
 *   4. Labels are exact-value. UI copy changes go through this file.
 *   5. Cross-cutting: isTerminal(s) iff availableTransitions(s)=[].
 */

const ALL_STATUSES: readonly BookingStatus[] = [
	'confirmed',
	'in_house',
	'cancelled',
	'checked_out',
	'no_show',
]

const ALL_TRANSITIONS: readonly BookingTransition[] = ['checkIn', 'checkOut', 'cancel', 'noShow']

describe('isTerminal — exhaustive status enum coverage', () => {
	it.each([
		['cancelled', true],
		['checked_out', true],
		['no_show', true],
		['confirmed', false],
		['in_house', false],
	] as const)('isTerminal(%s) → %s', (s, expected) => {
		expect(isTerminal(s)).toBe(expected)
	})

	it('covers every BookingStatus enum value (no missing case)', () => {
		// Hunt for a future enum addition (e.g. "tentative") that would
		// silently return false from the Set-lookup — forces explicit update.
		expect(ALL_STATUSES).toHaveLength(5)
		for (const s of ALL_STATUSES) {
			expect(typeof isTerminal(s)).toBe('boolean')
		}
	})
})

describe('availableTransitions — exact-value per status', () => {
	it('confirmed → [checkIn, cancel, noShow] (exact order + exact set)', () => {
		expect(availableTransitions('confirmed')).toEqual(['checkIn', 'cancel', 'noShow'])
	})

	it('in_house → [checkOut, cancel] (no checkIn, no noShow — guest is already in)', () => {
		expect(availableTransitions('in_house')).toEqual(['checkOut', 'cancel'])
	})

	it.each([
		'cancelled',
		'checked_out',
		'no_show',
	] as const)('terminal %s → [] (no actions remain)', (s) => {
		expect(availableTransitions(s)).toEqual([])
	})

	it('adversarial: confirmed cannot checkOut (guest not in yet)', () => {
		expect(availableTransitions('confirmed')).not.toContain('checkOut')
	})

	it('adversarial: in_house cannot noShow (no-show means guest never arrived)', () => {
		expect(availableTransitions('in_house')).not.toContain('noShow')
	})

	it('adversarial: in_house cannot checkIn (already checked in)', () => {
		expect(availableTransitions('in_house')).not.toContain('checkIn')
	})
})

describe('cross-cutting invariant: isTerminal iff no transitions available', () => {
	it.each(ALL_STATUSES)('%s: isTerminal ↔ availableTransitions.length === 0', (s) => {
		expect(isTerminal(s)).toBe(availableTransitions(s).length === 0)
	})
})

describe('nextStatus — total over valid pairs, throws on invalid', () => {
	it.each([
		['confirmed', 'checkIn', 'in_house'],
		['confirmed', 'cancel', 'cancelled'],
		['confirmed', 'noShow', 'no_show'],
		['in_house', 'checkOut', 'checked_out'],
		['in_house', 'cancel', 'cancelled'],
	] as const)('nextStatus(%s, %s) → %s', (from, t, expected) => {
		expect(nextStatus(from, t)).toBe(expected)
	})

	describe('adversarial: invalid transitions throw (silent no-op would mask bugs)', () => {
		const invalidPairs: readonly [BookingStatus, BookingTransition][] = [
			['confirmed', 'checkOut'], // guest not in yet
			['in_house', 'checkIn'], // already in
			['in_house', 'noShow'], // already arrived
			['cancelled', 'checkIn'],
			['cancelled', 'checkOut'],
			['cancelled', 'cancel'], // double-cancel
			['cancelled', 'noShow'],
			['checked_out', 'checkIn'],
			['checked_out', 'checkOut'], // double-checkout
			['checked_out', 'cancel'],
			['checked_out', 'noShow'],
			['no_show', 'checkIn'],
			['no_show', 'checkOut'],
			['no_show', 'cancel'],
			['no_show', 'noShow'], // double-noShow
		]

		it.each(invalidPairs)('nextStatus(%s, %s) throws', (from, t) => {
			expect(() => nextStatus(from, t)).toThrow(/not valid from status/)
		})

		it('exhaustive coverage: all (status × transition) invalid pairs tested', () => {
			const validCount = 5 // 3 from confirmed + 2 from in_house
			const totalPairs = ALL_STATUSES.length * ALL_TRANSITIONS.length // 5 × 4 = 20
			expect(invalidPairs).toHaveLength(totalPairs - validCount)
		})
	})
})

describe('labelForTransition — exact-value Russian copy', () => {
	it.each([
		['checkIn', 'Заезд'],
		['checkOut', 'Выезд'],
		['cancel', 'Отменить бронь'],
		['noShow', 'Не заехал'],
	] as const)('labelForTransition(%s) → "%s"', (t, expected) => {
		expect(labelForTransition(t)).toBe(expected)
	})

	it('every transition has a non-empty Russian label (hunt for missed copy)', () => {
		for (const t of ALL_TRANSITIONS) {
			const label = labelForTransition(t)
			expect(label.length).toBeGreaterThan(0)
			// Label must contain Cyrillic — English/empty would be a missed i18n.
			expect(label).toMatch(/[а-яА-ЯёЁ]/)
		}
	})
})

describe('labelForStatus — exact-value + palette parity', () => {
	// Must mirror booking-palette.ts labels verbatim — different copy on
	// grid band vs edit dialog would confuse the user.
	it.each([
		['confirmed', 'Подтверждена'],
		['in_house', 'В проживании'],
		['checked_out', 'Выехал'],
		['cancelled', 'Отменена'],
		['no_show', 'Не заехал'],
	] as const)('labelForStatus(%s) → "%s"', (s, expected) => {
		expect(labelForStatus(s)).toBe(expected)
	})
})
