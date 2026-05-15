import type { BookingStatus } from '@horeca/shared'
import { describe, expect, it } from 'bun:test'
import {
	BOOKING_CELL_STYLES,
	DERIVED_BOOKING_CELL_STYLES,
	paletteFor,
	styleFor,
} from './booking-palette.ts'

describe('booking-palette (M9.5 Phase B Bnovo-parity tokens)', () => {
	const ALL_STATUSES: readonly BookingStatus[] = [
		'confirmed',
		'in_house',
		'checked_out',
		'cancelled',
		'no_show',
	] as const

	describe('exhaustiveness — every backend status has a style', () => {
		it.each([...ALL_STATUSES])(
			'styleFor(%s) returns style with bg+text+label',
			(status: BookingStatus) => {
				const s = styleFor(status)
				expect(s.bg).toMatch(/^bg-status-/)
				expect(s.text).toMatch(/^text-status-/)
				expect(s.label.length).toBeGreaterThan(0)
			},
		)
	})

	describe('exact-value labels (ru-RU, no accidental drift)', () => {
		it('confirmed → Подтверждена', () => {
			expect(styleFor('confirmed').label).toBe('Подтверждена')
		})
		it('in_house → В проживании', () => {
			expect(styleFor('in_house').label).toBe('В проживании')
		})
		it('checked_out → Выехал', () => {
			expect(styleFor('checked_out').label).toBe('Выехал')
		})
		it('cancelled → Отменена', () => {
			expect(styleFor('cancelled').label).toBe('Отменена')
		})
		it('no_show → Не заехал', () => {
			expect(styleFor('no_show').label).toBe('Не заехал')
		})
	})

	describe('Bnovo-parity token mapping', () => {
		it('confirmed → status-confirmed (green = pre-arrival)', () => {
			expect(styleFor('confirmed').bg).toBe('bg-status-confirmed hover:brightness-95')
			expect(styleFor('confirmed').text).toBe('text-status-confirmed-foreground')
		})
		it('in_house → status-occupied (Sochi-blue = currently in-house)', () => {
			expect(styleFor('in_house').bg).toBe('bg-status-occupied hover:brightness-95')
			expect(styleFor('in_house').text).toBe('text-status-occupied-foreground')
		})
		it('checked_out → status-past (grey)', () => {
			expect(styleFor('checked_out').bg).toBe('bg-status-past hover:brightness-95')
		})
		it('cancelled → status-past + line-through visual', () => {
			expect(styleFor('cancelled').bg).toBe('bg-status-past line-through hover:brightness-95')
		})
		it('no_show → status-issue (red — exception requiring action)', () => {
			expect(styleFor('no_show').bg).toBe('bg-status-issue hover:brightness-95')
			expect(styleFor('no_show').text).toBe('text-status-issue-foreground')
		})
	})

	describe('no hardcoded shadcn neutral palette (theme-aware tokens only)', () => {
		it.each([...ALL_STATUSES])(
			'styleFor(%s) NOT use bg-neutral-/bg-blue-/bg-yellow-',
			(status: BookingStatus) => {
				const bg = styleFor(status).bg
				expect(bg).not.toMatch(/bg-neutral-/)
				expect(bg).not.toMatch(/bg-blue-\d/)
				expect(bg).not.toMatch(/bg-yellow-\d/)
			},
		)
	})

	describe('immutability — frozen-style table', () => {
		it('BOOKING_CELL_STYLES referentially stable across calls', () => {
			expect(styleFor('confirmed')).toBe(BOOKING_CELL_STYLES.confirmed)
			expect(styleFor('confirmed')).toBe(styleFor('confirmed'))
		})
	})
})

/**
 * G2 TravelLine 8-color canon extension (2026-05-15) — `paletteFor`
 * derived states. Per `[[strict-tests]]` exact-value + adversarial +
 * immutable.
 *
 *   Precedence canon (top-down — first match wins):
 *     [P1] terminal (cancelled / checked_out / no_show) → domain palette
 *     [P2] confirmed + checkIn < today → overdue (red)
 *     [P3] confirmed + assignedRoomId null → unassigned (turquoise)
 *     [P4] confirmed + checkIn ≥ today + assigned → confirmed (green)
 *     [P5] in_house → occupied (blue), no derived overlay
 *
 *   Adversarial:
 *     [A1] cancelled с overdue conditions → cancelled wins (terminal)
 *     [A2] checked_out с unassigned → checked_out wins (historical)
 *     [A3] no_show с overdue → no_show wins (terminal urgency = no_show
 *          already past «action required» — operator already decided)
 *     [A4] confirmed + checkIn yesterday + unassigned → overdue wins
 *          (most-urgent canon: check-in before room assignment)
 *
 *   Immutable:
 *     [I1] DERIVED_BOOKING_CELL_STYLES references stable across calls
 *     [I2] same inputs → same output reference (no allocation in hot path)
 */
describe('paletteFor — G2 derived states', () => {
	const TODAY = '2026-05-15'
	const YESTERDAY = '2026-05-14'
	const TOMORROW = '2026-05-16'

	describe('[P1] terminal statuses always win', () => {
		it('cancelled → past + line-through, regardless of checkIn / assignedRoomId', () => {
			expect(
				paletteFor({
					booking: { status: 'cancelled', checkIn: YESTERDAY, assignedRoomId: null },
					todayIso: TODAY,
				}),
			).toBe(BOOKING_CELL_STYLES.cancelled)
		})
		it('checked_out → past (terminal historical)', () => {
			expect(
				paletteFor({
					booking: { status: 'checked_out', checkIn: YESTERDAY, assignedRoomId: null },
					todayIso: TODAY,
				}),
			).toBe(BOOKING_CELL_STYLES.checked_out)
		})
		it('no_show → issue (operator already decided urgency)', () => {
			expect(
				paletteFor({
					booking: { status: 'no_show', checkIn: YESTERDAY, assignedRoomId: null },
					todayIso: TODAY,
				}),
			).toBe(BOOKING_CELL_STYLES.no_show)
		})
	})

	describe('[P2-P4] confirmed precedence: overdue > unassigned > confirmed', () => {
		it('[P2] confirmed + checkIn yesterday → overdue (red, «Просрочена»)', () => {
			const result = paletteFor({
				booking: { status: 'confirmed', checkIn: YESTERDAY, assignedRoomId: 'room_1' },
				todayIso: TODAY,
			})
			expect(result).toBe(DERIVED_BOOKING_CELL_STYLES.overdue)
			expect(result.label).toBe('Просрочена')
			expect(result.bg).toBe('bg-status-issue hover:brightness-95')
		})
		it('[P3] confirmed + future checkIn + unassigned → unassigned (turquoise)', () => {
			const result = paletteFor({
				booking: { status: 'confirmed', checkIn: TOMORROW, assignedRoomId: null },
				todayIso: TODAY,
			})
			expect(result).toBe(DERIVED_BOOKING_CELL_STYLES.unassigned)
			expect(result.label).toBe('Не распределена')
			expect(result.bg).toBe('bg-status-unassigned hover:brightness-95')
		})
		it('[P4] confirmed + future + assigned → confirmed (green, base)', () => {
			expect(
				paletteFor({
					booking: { status: 'confirmed', checkIn: TOMORROW, assignedRoomId: 'room_1' },
					todayIso: TODAY,
				}),
			).toBe(BOOKING_CELL_STYLES.confirmed)
		})
		it('[P4.boundary] confirmed + checkIn === today + assigned → confirmed (today is not «overdue»)', () => {
			expect(
				paletteFor({
					booking: { status: 'confirmed', checkIn: TODAY, assignedRoomId: 'room_1' },
					todayIso: TODAY,
				}),
			).toBe(BOOKING_CELL_STYLES.confirmed)
		})
	})

	describe('[P5] in_house — no derived overlays (guest already checked in)', () => {
		it('in_house + past checkIn → still in_house (occupied blue)', () => {
			expect(
				paletteFor({
					booking: { status: 'in_house', checkIn: YESTERDAY, assignedRoomId: 'room_1' },
					todayIso: TODAY,
				}),
			).toBe(BOOKING_CELL_STYLES.in_house)
		})
		it('in_house + null assignedRoomId (data integrity edge) → still in_house', () => {
			expect(
				paletteFor({
					booking: { status: 'in_house', checkIn: YESTERDAY, assignedRoomId: null },
					todayIso: TODAY,
				}),
			).toBe(BOOKING_CELL_STYLES.in_house)
		})
	})

	describe('adversarial precedence', () => {
		it('[A4] confirmed + checkIn yesterday + unassigned → overdue wins (most-urgent canon)', () => {
			expect(
				paletteFor({
					booking: { status: 'confirmed', checkIn: YESTERDAY, assignedRoomId: null },
					todayIso: TODAY,
				}),
			).toBe(DERIVED_BOOKING_CELL_STYLES.overdue)
		})
	})

	describe('immutable references (memoization-safe)', () => {
		const args = {
			booking: {
				status: 'confirmed' as BookingStatus,
				checkIn: '2026-05-16',
				assignedRoomId: 'r1',
			},
			todayIso: '2026-05-15',
		}
		it('[I1] DERIVED_BOOKING_CELL_STYLES stable across calls', () => {
			expect(DERIVED_BOOKING_CELL_STYLES.overdue).toBe(DERIVED_BOOKING_CELL_STYLES.overdue)
			expect(DERIVED_BOOKING_CELL_STYLES.unassigned).toBe(DERIVED_BOOKING_CELL_STYLES.unassigned)
		})
		it('[I2] same inputs → same output reference', () => {
			expect(paletteFor(args)).toBe(paletteFor(args))
		})
	})

	describe('no hardcoded palettes в derived styles', () => {
		it('overdue NOT использует bg-neutral-/bg-yellow-/bg-red-NNN', () => {
			expect(DERIVED_BOOKING_CELL_STYLES.overdue.bg).not.toMatch(/bg-(neutral|yellow|red)-\d/)
		})
		it('unassigned NOT использует hardcoded palette', () => {
			expect(DERIVED_BOOKING_CELL_STYLES.unassigned.bg).not.toMatch(/bg-(neutral|yellow|red)-\d/)
		})
	})
})
