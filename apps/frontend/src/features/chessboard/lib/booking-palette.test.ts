import type { BookingStatus } from '@horeca/shared'
import { describe, expect, it } from 'vitest'
import { BOOKING_CELL_STYLES, styleFor } from './booking-palette.ts'

describe('booking-palette', () => {
	const ALL_STATUSES: readonly BookingStatus[] = [
		'confirmed',
		'in_house',
		'checked_out',
		'cancelled',
		'no_show',
	] as const

	describe('exhaustiveness (every backend status has a style)', () => {
		it.each(ALL_STATUSES)('styleFor(%s) returns style with bg+text+label', (status) => {
			const s = styleFor(status)
			expect(s.bg).toMatch(/^bg-/)
			expect(s.text).toMatch(/^text-/)
			expect(s.label.length).toBeGreaterThan(0)
		})
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

	describe('Mews 2026 palette rules', () => {
		it('confirmed is blue (action color)', () => {
			expect(styleFor('confirmed').bg).toMatch(/bg-blue-/)
		})
		it('in_house is dark (occupied, black-family)', () => {
			expect(styleFor('in_house').bg).toMatch(/bg-neutral-9/)
		})
		it('no_show is yellow (alert, not cancelled)', () => {
			expect(styleFor('no_show').bg).toMatch(/bg-yellow-/)
		})
		it('cancelled has line-through visual', () => {
			expect(styleFor('cancelled').bg).toMatch(/line-through/)
		})
	})

	describe('immutability (frozen-style table)', () => {
		it('BOOKING_CELL_STYLES is frozen-read at TS level — mutation fails to compile', () => {
			// Runtime `Object.freeze` not enforced (TS-level readonly) — we
			// assert referential stability across calls as a proxy.
			expect(styleFor('confirmed')).toBe(BOOKING_CELL_STYLES.confirmed)
			expect(styleFor('confirmed')).toBe(styleFor('confirmed'))
		})
	})
})
