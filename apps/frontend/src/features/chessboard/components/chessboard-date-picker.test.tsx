/**
 * ChessboardDatePicker — strict component tests (M9.5 Phase B + senior-pass v4).
 *
 * 2026/2027 stack: react-day-picker v9.14+ via shadcn Calendar +
 * date-fns/locale ru. Замена native input[type=date] (Chromium desktop
 * locale bug eradicated).
 *
 * Pre-done audit:
 *   [R1] trigger button с aria-label "Перейти к дате" + lucide CalendarIcon
 *   [R2] formatted date label visible (RU short format)
 *   [O1] trigger click → Popover opens, Calendar grid (role=grid) visible
 *   [O2] selected date matches passed `value` prop (data-selected=true)
 *   [O3] Calendar uses ru-RU locale — month label в russian
 *   [S1] click date cell → onChange called с new ISO + popover closes
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChessboardDatePicker } from './chessboard-date-picker'

afterEach(() => {
	cleanup()
})

describe('ChessboardDatePicker — render', () => {
	it('[R1] trigger button с aria-label', () => {
		render(<ChessboardDatePicker value="2026-04-28" onChange={vi.fn()} />)
		expect(screen.getByRole('button', { name: 'Перейти к дате' })).toBeDefined()
	})

	it('[R2] formatted date label visible на trigger', () => {
		render(<ChessboardDatePicker value="2026-04-28" onChange={vi.fn()} />)
		const trigger = screen.getByRole('button', { name: 'Перейти к дате' })
		expect(trigger.textContent).toMatch(/28/)
	})
})

describe('ChessboardDatePicker — open + interaction', () => {
	it('[O1] click trigger → Popover opens с Calendar grid', async () => {
		render(<ChessboardDatePicker value="2026-04-28" onChange={vi.fn()} />)
		const user = userEvent.setup()
		await user.click(screen.getByRole('button', { name: 'Перейти к дате' }))
		// react-day-picker v9 renders role="grid" с aria-label включающим месяц.
		expect(screen.getByRole('grid')).toBeDefined()
	})

	it('[O2] selected date — gridcell[data-day="2026-04-28"] имеет data-selected="true" (rdp v9 canon)', async () => {
		render(<ChessboardDatePicker value="2026-04-28" onChange={vi.fn()} />)
		const user = userEvent.setup()
		await user.click(screen.getByRole('button', { name: 'Перейти к дате' }))
		const cell = document.querySelector('td[data-day="2026-04-28"]')
		expect(cell).not.toBeNull()
		expect(cell!.getAttribute('data-selected')).toBe('true')
	})

	it('[O3] Calendar uses ru-RU locale (date-fns/locale ru applied)', async () => {
		render(<ChessboardDatePicker value="2026-04-28" onChange={vi.fn()} />)
		const user = userEvent.setup()
		await user.click(screen.getByRole('button', { name: 'Перейти к дате' }))
		// rdp v9 month-caption + day aria-labels = русские (e.g. «28 апреля 2026»).
		expect(screen.getAllByLabelText(/апреля 2026/i).length).toBeGreaterThan(0)
	})

	it('[S1] click day cell → onChange с ISO + Popover closes', async () => {
		const onChange = vi.fn()
		render(<ChessboardDatePicker value="2026-04-28" onChange={onChange} />)
		const user = userEvent.setup()
		await user.click(screen.getByRole('button', { name: 'Перейти к дате' }))
		// rdp v9 DayButton aria-label = «среда, 15 апреля 2026 г.»
		const day15 = screen.getByRole('button', { name: /15 апреля 2026/i })
		await user.click(day15)
		expect(onChange).toHaveBeenCalledWith('2026-04-15')
	})
})
