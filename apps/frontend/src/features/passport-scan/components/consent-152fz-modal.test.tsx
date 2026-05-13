/**
 * 152-ФЗ Consent modal — strict tests.
 *
 * Pre-done audit (legal compliance critical):
 *   [G1] checkbox unchecked → Accept button disabled (gate enforces)
 *   [G2] checkbox checked → Accept button enabled
 *   [G3] uncheck after check → Accept button disabled again
 *   [G4] Cancel button always enabled (user can always decline)
 *   [G5] Modal text contains specific 152-ФЗ references (per 2025-09-01 separate document)
 *   [G6] Modal text contains version + Постановление №1668 (specific goals)
 *   [G7] open=false → modal NOT rendered
 *   [G8] Cancel callback fires onCancel
 *   [G9] Accept callback fires onAccept (only когда checkbox checked)
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, mock } from 'bun:test'
import { Consent152FzModal } from './consent-152fz-modal.tsx'

afterEach(cleanup)

describe('Consent152FzModal — gate semantics (legal compliance)', () => {
	test('[G1] checkbox unchecked → Accept disabled', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const acceptBtn = screen.getByRole('button', { name: /Подтвердить согласие/ })
		expect((acceptBtn as HTMLButtonElement).disabled).toBe(true)
	})

	test('[G2] checkbox checked → Accept enabled', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const checkbox = screen.getByRole('checkbox')
		fireEvent.click(checkbox)
		const acceptBtn = screen.getByRole('button', { name: /Подтвердить согласие/ })
		expect((acceptBtn as HTMLButtonElement).disabled).toBe(false)
	})

	test('[G3] uncheck after check → Accept disabled again', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const checkbox = screen.getByRole('checkbox')
		fireEvent.click(checkbox)
		fireEvent.click(checkbox)
		const acceptBtn = screen.getByRole('button', { name: /Подтвердить согласие/ })
		expect((acceptBtn as HTMLButtonElement).disabled).toBe(true)
	})

	test('[G4] Cancel button always enabled', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const cancelBtn = screen.getByRole('button', { name: /Отклонить/ })
		expect((cancelBtn as HTMLButtonElement).disabled).toBe(false)
	})

	test('[G5] modal contains 152-ФЗ references', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		// Long legal text rendered as preserved-newlines block — check key fragments
		const body = document.body.textContent ?? ''
		expect(body).toContain('152-ФЗ')
		expect(body).toContain('О персональных данных')
	})

	test('[G6] modal contains Постановление №1668 (specific goals)', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const body = document.body.textContent ?? ''
		expect(body).toContain('1668')
		expect(body).toContain('ГС МИР')
	})

	test('[G7] open=false → modal not rendered', () => {
		render(<Consent152FzModal open={false} onAccept={mock()} onCancel={mock()} />)
		const dialog = screen.queryByRole('dialog')
		expect(dialog).toBeNull()
	})

	test('[G8] Cancel callback fires onCancel', () => {
		const onCancel = mock()
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={onCancel} />)
		fireEvent.click(screen.getByRole('button', { name: /Отклонить/ }))
		expect(onCancel).toHaveBeenCalledTimes(1)
	})

	test('[G9] Accept callback fires only after checkbox check', () => {
		const onAccept = mock()
		render(<Consent152FzModal open={true} onAccept={onAccept} onCancel={mock()} />)
		// Accept disabled — click bear no effect
		const acceptBtn = screen.getByRole('button', { name: /Подтвердить согласие/ })
		fireEvent.click(acceptBtn)
		expect(onAccept).not.toHaveBeenCalled()
		// Now check + click
		fireEvent.click(screen.getByRole('checkbox'))
		fireEvent.click(acceptBtn)
		expect(onAccept).toHaveBeenCalledTimes(1)
	})
})
