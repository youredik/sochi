/**
 * `<DateRangePicker>` — strict tests.
 *
 * Covers:
 *   [D1] Trigger renders с current range label
 *   [D2] aria-label includes current range
 *   [D3] disabled prop blocks trigger
 *   [D4] Click trigger opens popover (presence of grid)
 *
 * Range select interaction tested via E2E (W6) — happy-dom не симулирует
 * react-day-picker focus/click pixel-perfect; component contract verified
 * через behavior asserts above + E2E happy path для full keyboard nav.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { DateRangePicker } from './date-range-picker.tsx'

afterEach(() => cleanup())

describe('<DateRangePicker>', () => {
	test('[D1] Trigger renders с formatted range', () => {
		render(<DateRangePicker checkIn="2026-06-01" checkOut="2026-06-06" onChange={() => {}} />)
		// formatDateRange returns "1–6 июня 2026" для same-month
		expect(screen.getByRole('button').textContent).toContain('1–6 июня 2026')
	})

	test('[D2] aria-label includes both check-in and -out info', () => {
		render(<DateRangePicker checkIn="2026-06-01" checkOut="2026-06-06" onChange={() => {}} />)
		const btn = screen.getByRole('button')
		const label = btn.getAttribute('aria-label') ?? ''
		expect(label).toContain('Выбрать даты заезда и выезда')
		expect(label).toContain('1–6 июня 2026')
	})

	test('[D3] disabled prop blocks trigger', () => {
		render(
			<DateRangePicker checkIn="2026-06-01" checkOut="2026-06-06" onChange={() => {}} disabled />,
		)
		expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
	})

	test('[D4] Click trigger opens popover with grid (react-day-picker rendered)', () => {
		render(<DateRangePicker checkIn="2026-06-01" checkOut="2026-06-06" onChange={() => {}} />)
		fireEvent.click(screen.getByRole('button'))
		// react-day-picker v9 renders role="grid" с aria-label содержащим месяц
		const grids = screen.getAllByRole('grid')
		expect(grids.length).toBeGreaterThanOrEqual(1)
	})

	test('[D5] Trigger label has eyebrow text "Даты проживания"', () => {
		render(<DateRangePicker checkIn="2026-06-01" checkOut="2026-06-06" onChange={() => {}} />)
		expect(screen.getByText('Даты проживания')).toBeTruthy()
	})

	test('[D6] Cross-month range correctly formatted в trigger', () => {
		render(<DateRangePicker checkIn="2026-06-30" checkOut="2026-07-03" onChange={() => {}} />)
		expect(screen.getByRole('button').textContent).toContain('30 июня — 3 июля 2026')
	})
})
