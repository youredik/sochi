import type { BookingStatus } from '@horeca/shared'
import { describe, expect, it } from 'vitest'
import { BOOKING_CELL_STYLES, styleFor } from './booking-palette.ts'

describe('booking-palette (M9.5 Phase B Bnovo-parity tokens)', () => {
	const ALL_STATUSES: readonly BookingStatus[] = [
		'confirmed',
		'in_house',
		'checked_out',
		'cancelled',
		'no_show',
	] as const

	describe('exhaustiveness — every backend status has a style', () => {
		it.each(ALL_STATUSES)('styleFor(%s) returns style with bg+text+label', (status) => {
			const s = styleFor(status)
			expect(s.bg).toMatch(/^bg-status-/)
			expect(s.text).toMatch(/^text-status-/)
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
		it.each(ALL_STATUSES)('styleFor(%s) NOT use bg-neutral-/bg-blue-/bg-yellow-', (status) => {
			const bg = styleFor(status).bg
			expect(bg).not.toMatch(/bg-neutral-/)
			expect(bg).not.toMatch(/bg-blue-\d/)
			expect(bg).not.toMatch(/bg-yellow-\d/)
		})
	})

	describe('immutability — frozen-style table', () => {
		it('BOOKING_CELL_STYLES referentially stable across calls', () => {
			expect(styleFor('confirmed')).toBe(BOOKING_CELL_STYLES.confirmed)
			expect(styleFor('confirmed')).toBe(styleFor('confirmed'))
		})
	})
})
