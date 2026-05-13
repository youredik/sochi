/**
 * `<GuestSelector>` — strict adversarial component tests per `feedback_strict_tests.md`.
 *
 * Test matrix:
 *   [G1] Renders trigger label с правильным RU plural (1 → взрослый, 2-4 → взрослых, etc.)
 *   [G2] Children > 0 rendered в trigger label
 *   [G3] Children = 0 NOT rendered в trigger label
 *   [G4] Stepper plus disabled when total === maxTotal
 *   [G5] Stepper minus disabled when adults === 1 (anti-zero invariant)
 *   [G6] Children minus disabled when children === 0
 *   [G7] onChange called с corrected adults/children counts
 *   [G8] Hint text mentions max guests с CLDR plural
 *   [G9] aria-label на trigger разъясняет current selection
 *   [G10] disabled prop сlocks trigger
 */
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, test, mock } from 'bun:test'
import { GuestSelector } from './guest-selector.tsx'

afterEach(() => cleanup())

// userEvent awaits microtasks + wraps в act — needed for Radix Popover triggers
// под React 19 strict-mode (PopperContent/FocusScope/DismissableLayer/Presence
// state updates fire async after click → vanilla fireEvent leaves act-warning).
const user = userEvent.setup()

describe('<GuestSelector>', () => {
	test('[G1] trigger label uses CLDR plural — 1 adult → "взрослый"', () => {
		render(<GuestSelector adults={1} childrenCount={0} onChange={() => {}} />)
		expect(screen.getByRole('button').textContent).toContain('1 взрослый')
	})

	test('[G1b] 2 adults → "взрослых" (genitive)', () => {
		render(<GuestSelector adults={2} childrenCount={0} onChange={() => {}} />)
		expect(screen.getByRole('button').textContent).toContain('2 взрослых')
	})

	test('[G2] children > 0 → comma-separated в label', () => {
		render(<GuestSelector adults={2} childrenCount={1} onChange={() => {}} />)
		expect(screen.getByRole('button').textContent).toContain('2 взрослых, 1 ребёнок')
	})

	test('[G3] children = 0 → no children mention в label', () => {
		render(<GuestSelector adults={2} childrenCount={0} onChange={() => {}} />)
		expect(screen.getByRole('button').textContent).not.toMatch(/реб/)
	})

	test('[G4] adults plus disabled when total reaches maxTotal', async () => {
		render(<GuestSelector adults={4} childrenCount={2} onChange={() => {}} maxTotal={6} />)
		await user.click(screen.getByRole('button'))
		const plusBtn = screen.getByTestId('guests-adults-plus')
		expect((plusBtn as HTMLButtonElement).disabled).toBe(true)
	})

	test('[G5] adults minus disabled when adults === 1', async () => {
		render(<GuestSelector adults={1} childrenCount={0} onChange={() => {}} />)
		await user.click(screen.getByRole('button'))
		const minusBtn = screen.getByTestId('guests-adults-minus')
		expect((minusBtn as HTMLButtonElement).disabled).toBe(true)
	})

	test('[G6] children minus disabled when children === 0', async () => {
		render(<GuestSelector adults={2} childrenCount={0} onChange={() => {}} />)
		await user.click(screen.getByRole('button'))
		const minusBtn = screen.getByTestId('guests-children-minus')
		expect((minusBtn as HTMLButtonElement).disabled).toBe(true)
	})

	test('[G7] adults plus calls onChange with adults+1, children unchanged', async () => {
		const onChange = mock()
		render(<GuestSelector adults={2} childrenCount={1} onChange={onChange} />)
		await user.click(screen.getByRole('button'))
		await user.click(screen.getByTestId('guests-adults-plus'))
		expect(onChange).toHaveBeenCalledWith({ adults: 3, childrenCount: 1 })
	})

	test('[G7b] children plus calls onChange with children+1, adults unchanged', async () => {
		const onChange = mock()
		render(<GuestSelector adults={2} childrenCount={0} onChange={onChange} />)
		await user.click(screen.getByRole('button'))
		await user.click(screen.getByTestId('guests-children-plus'))
		expect(onChange).toHaveBeenCalledWith({ adults: 2, childrenCount: 1 })
	})

	test('[G7c] adults minus calls onChange with adults-1', async () => {
		const onChange = mock()
		render(<GuestSelector adults={3} childrenCount={0} onChange={onChange} />)
		await user.click(screen.getByRole('button'))
		await user.click(screen.getByTestId('guests-adults-minus'))
		expect(onChange).toHaveBeenCalledWith({ adults: 2, childrenCount: 0 })
	})

	test('[G8] hint mentions max guests с RU plural', async () => {
		render(<GuestSelector adults={1} childrenCount={0} onChange={() => {}} maxTotal={6} />)
		await user.click(screen.getByRole('button'))
		const hint = screen.getByText(/Максимум 6 гостей/)
		expect(hint).not.toBe(null)
	})

	test('[G9] aria-label includes current selection (a11y screen-reader)', () => {
		render(<GuestSelector adults={2} childrenCount={1} onChange={() => {}} />)
		const btn = screen.getByRole('button')
		expect(btn.getAttribute('aria-label')).toContain('2 взрослых, 1 ребёнок')
	})

	test('[G10] disabled prop blocks trigger', () => {
		render(<GuestSelector adults={2} childrenCount={0} onChange={() => {}} disabled />)
		expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
	})

	test('[G11] adults value display shows actual number (tabular-nums)', async () => {
		render(<GuestSelector adults={3} childrenCount={0} onChange={() => {}} />)
		await user.click(screen.getByRole('button'))
		expect(screen.getByTestId('guests-adults-value').textContent).toBe('3')
	})
})
