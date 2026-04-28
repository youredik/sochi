/**
 * ChessboardDatePicker — strict component tests (M9.5 Phase B).
 *
 * Pre-done audit:
 *   [R1] trigger button с aria-label "Перейти к дате" + lucide CalendarIcon
 *   [R2] formatted date label visible на trigger (RU short format)
 *   [O1] trigger click → Popover opens, native input[type=date] visible
 *   [O2] input value === passed `value` prop
 *   [S1] input change → onChange called с new ISO + popover closes
 *   [S2] empty string change → onChange NOT called (suppress invalid)
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
		// formatDateShort('2026-04-28') → "28 апр." or similar Russian short format.
		expect(trigger.textContent).toMatch(/28/)
	})
})

describe('ChessboardDatePicker — open + change', () => {
	it('[O1] click trigger → Popover opens with native date input', async () => {
		render(<ChessboardDatePicker value="2026-04-28" onChange={vi.fn()} />)
		const user = userEvent.setup()
		await user.click(screen.getByRole('button', { name: 'Перейти к дате' }))
		const input = screen.getByLabelText('Выберите дату для перехода') as HTMLInputElement
		expect(input).toBeDefined()
		expect(input.type).toBe('date')
	})

	it('[O2] input value === value prop', async () => {
		render(<ChessboardDatePicker value="2026-04-28" onChange={vi.fn()} />)
		const user = userEvent.setup()
		await user.click(screen.getByRole('button', { name: 'Перейти к дате' }))
		const input = screen.getByLabelText('Выберите дату для перехода') as HTMLInputElement
		expect(input.value).toBe('2026-04-28')
	})

	it('[S1] change non-empty → onChange called с new ISO', async () => {
		const onChange = vi.fn()
		render(<ChessboardDatePicker value="2026-04-28" onChange={onChange} />)
		const user = userEvent.setup()
		await user.click(screen.getByRole('button', { name: 'Перейти к дате' }))
		const input = screen.getByLabelText('Выберите дату для перехода') as HTMLInputElement
		fireEvent.change(input, { target: { value: '2026-05-01' } })
		expect(onChange).toHaveBeenCalledWith('2026-05-01')
	})

	it('[S2] empty string change does NOT trigger onChange', async () => {
		const onChange = vi.fn()
		render(<ChessboardDatePicker value="2026-04-28" onChange={onChange} />)
		const user = userEvent.setup()
		await user.click(screen.getByRole('button', { name: 'Перейти к дате' }))
		const input = screen.getByLabelText('Выберите дату для перехода') as HTMLInputElement
		fireEvent.change(input, { target: { value: '' } })
		expect(onChange).not.toHaveBeenCalled()
	})
})
