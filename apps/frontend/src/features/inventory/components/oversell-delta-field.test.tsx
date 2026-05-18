/**
 * `<OversellDeltaField>` — strict tests per `[[strict-tests]]` + `[[pre-done-audit]]`.
 *
 * Render:
 *   [R1] renders с initial value 0 → input shows "0", both buttons enabled
 *   [R2] renders с positive value → input shows "+N" via signed formatter (через aria-label)
 *   [R3] renders с negative value → input shows "−N" via signed formatter
 *   [R4] aria-labels present on +/− buttons + input (a11y canon)
 *
 * Interaction (signed-stepper):
 *   [S1] click + button → onChange(value+step)
 *   [S2] click − button → onChange(value-step)
 *   [S3] PageUp keyboard → onChange(value + step*10)
 *   [S4] PageDown keyboard → onChange(value - step*10)
 *
 * Bounds (clamping, no silent corruption):
 *   [B1] decrement disabled когда value <= min
 *   [B2] increment disabled когда value >= max
 *   [B3] decrement clamped: value=min, click − → still onChange(min), NOT min-1
 *   [B4] disabled prop → both buttons disabled regardless of bounds
 *
 * Input typing (no silent clamp during typing):
 *   [T1] valid integer typed → onChange с parsed value
 *   [T2] empty string typed → NO onChange (waits for blur)
 *   [T3] single minus typed → NO onChange (transient state)
 *   [T4] blur on empty → onChange(0)
 *   [T5] blur on out-of-bounds → clamped к min/max
 *
 * Badge (read-only display):
 *   [BD1] value=0 → returns null (no badge rendered)
 *   [BD2] positive value → amber color class + «+N» text
 *   [BD3] negative value → rose color class + «−N» text
 *
 * Adversarial:
 *   [A1] disabled does NOT call onChange on +/− click
 *   [A2] value exactly at min — decrement disabled, increment enabled
 *   [A3] value exactly at max — increment disabled, decrement enabled
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { OversellDeltaBadge, OversellDeltaField } from './oversell-delta-field.tsx'

afterEach(() => {
	cleanup()
})

describe('<OversellDeltaField>', () => {
	// ============== Render ==============

	it('[R1] renders с value=0, both buttons enabled', () => {
		render(<OversellDeltaField value={0} onChange={() => {}} />)
		const input = screen.getByRole('spinbutton') as HTMLInputElement
		expect(input.value).toBe('0')
		expect(
			(screen.getByRole('button', { name: 'Уменьшить овербукинг' }) as HTMLButtonElement).disabled,
		).toBe(false)
		expect(
			(screen.getByRole('button', { name: 'Увеличить овербукинг' }) as HTMLButtonElement).disabled,
		).toBe(false)
	})

	it('[R2] renders с positive value — signed aria-label includes «+N»', () => {
		render(<OversellDeltaField value={3} onChange={() => {}} />)
		const input = screen.getByRole('spinbutton') as HTMLInputElement
		expect(input.value).toBe('3')
		// aria-label uses signDisplay:exceptZero — «+3» в RU
		expect(input.getAttribute('aria-label')).toContain('+3')
	})

	it('[R3] renders с negative value — signed aria-label includes minus', () => {
		render(<OversellDeltaField value={-2} onChange={() => {}} />)
		const input = screen.getByRole('spinbutton') as HTMLInputElement
		expect(input.value).toBe('-2')
		// RU locale Intl выдаёт U+2212 minus, not hyphen
		expect(input.getAttribute('aria-label')).toMatch(/[−-]2/u)
	})

	it('[R4] a11y labels present на all three controls', () => {
		render(<OversellDeltaField value={0} onChange={() => {}} />)
		// getByRole throws if missing — assert tagName confirms it's the right element
		expect(screen.getByRole('button', { name: 'Уменьшить овербукинг' }).tagName).toBe('BUTTON')
		expect(screen.getByRole('button', { name: 'Увеличить овербукинг' }).tagName).toBe('BUTTON')
		const input = screen.getByRole('spinbutton')
		expect(input.getAttribute('aria-label')).toContain('Овербукинг')
	})

	// ============== Stepper Interaction ==============

	it('[S1] click + → onChange(value+step)', async () => {
		const onChange = mock<(v: number) => void>(() => {})
		render(<OversellDeltaField value={2} onChange={onChange} />)
		await userEvent.click(screen.getByRole('button', { name: 'Увеличить овербукинг' }))
		expect(onChange).toHaveBeenCalledWith(3)
	})

	it('[S2] click − → onChange(value-step)', async () => {
		const onChange = mock<(v: number) => void>(() => {})
		render(<OversellDeltaField value={2} onChange={onChange} />)
		await userEvent.click(screen.getByRole('button', { name: 'Уменьшить овербукинг' }))
		expect(onChange).toHaveBeenCalledWith(1)
	})

	it('[S3] PageUp → onChange(value + step*10) (W3C APG)', async () => {
		const onChange = mock<(v: number) => void>(() => {})
		render(<OversellDeltaField value={5} onChange={onChange} />)
		const input = screen.getByRole('spinbutton') as HTMLInputElement
		input.focus()
		fireEvent.keyDown(input, { key: 'PageUp' })
		expect(onChange).toHaveBeenCalledWith(15)
	})

	it('[S4] PageDown → onChange(value - step*10)', async () => {
		const onChange = mock<(v: number) => void>(() => {})
		render(<OversellDeltaField value={5} onChange={onChange} />)
		const input = screen.getByRole('spinbutton') as HTMLInputElement
		input.focus()
		fireEvent.keyDown(input, { key: 'PageDown' })
		expect(onChange).toHaveBeenCalledWith(-5)
	})

	// ============== Bounds ==============

	it('[B1] decrement disabled когда value <= min', () => {
		render(<OversellDeltaField value={-1000} onChange={() => {}} min={-1000} />)
		expect(
			(screen.getByRole('button', { name: 'Уменьшить овербукинг' }) as HTMLButtonElement).disabled,
		).toBe(true)
	})

	it('[B2] increment disabled когда value >= max', () => {
		render(<OversellDeltaField value={1000} onChange={() => {}} max={1000} />)
		expect(
			(screen.getByRole('button', { name: 'Увеличить овербукинг' }) as HTMLButtonElement).disabled,
		).toBe(true)
	})

	it('[B3] PageUp at max → clamped, NOT exceeded', () => {
		const onChange = mock<(v: number) => void>(() => {})
		render(<OversellDeltaField value={995} onChange={onChange} max={1000} />)
		const input = screen.getByRole('spinbutton')
		fireEvent.keyDown(input, { key: 'PageUp' })
		expect(onChange).toHaveBeenCalledWith(1000) // clamp 1005→1000
	})

	it('[B4] disabled prop → BOTH buttons disabled', () => {
		render(<OversellDeltaField value={5} onChange={() => {}} disabled={true} />)
		expect(
			(screen.getByRole('button', { name: 'Уменьшить овербукинг' }) as HTMLButtonElement).disabled,
		).toBe(true)
		expect(
			(screen.getByRole('button', { name: 'Увеличить овербукинг' }) as HTMLButtonElement).disabled,
		).toBe(true)
	})

	// ============== Input typing ==============

	it('[T1] type valid integer → onChange с parsed value', () => {
		const onChange = mock<(v: number) => void>(() => {})
		render(<OversellDeltaField value={0} onChange={onChange} />)
		const input = screen.getByRole('spinbutton') as HTMLInputElement
		fireEvent.change(input, { target: { value: '7' } })
		expect(onChange).toHaveBeenCalledWith(7)
	})

	it('[T2] type empty string → NO onChange (transient)', () => {
		const onChange = mock<(v: number) => void>(() => {})
		render(<OversellDeltaField value={5} onChange={onChange} />)
		const input = screen.getByRole('spinbutton') as HTMLInputElement
		fireEvent.change(input, { target: { value: '' } })
		expect(onChange).not.toHaveBeenCalled()
	})

	it('[T3] type single minus → NO onChange (transient)', () => {
		const onChange = mock<(v: number) => void>(() => {})
		render(<OversellDeltaField value={5} onChange={onChange} />)
		const input = screen.getByRole('spinbutton') as HTMLInputElement
		fireEvent.change(input, { target: { value: '-' } })
		expect(onChange).not.toHaveBeenCalled()
	})

	it('[T4] blur empty → onChange(0)', () => {
		const onChange = mock<(v: number) => void>(() => {})
		render(<OversellDeltaField value={5} onChange={onChange} />)
		const input = screen.getByRole('spinbutton') as HTMLInputElement
		fireEvent.blur(input, { target: { value: '' } })
		expect(onChange).toHaveBeenCalledWith(0)
	})

	it('[T5] legacy mode (no onOutOfRange): blur on out-of-bounds → clamped к max', () => {
		const onChange = mock<(v: number) => void>(() => {})
		render(<OversellDeltaField value={5} onChange={onChange} max={100} />)
		const input = screen.getByRole('spinbutton') as HTMLInputElement
		fireEvent.blur(input, { target: { value: '999' } })
		expect(onChange).toHaveBeenCalledWith(100)
	})

	it('[T5b] strict mode (onOutOfRange callback): out-of-bounds → callback fired, NO silent clamp', () => {
		// Per [[silent-clamp-anti-pattern]] strict canon: каждое silent изменение
		// operator intent = bug. Strict-mode caller surfaces FieldError + keeps
		// raw value visible. Component MUST NOT call onChange in this branch.
		const onChange = mock<(v: number) => void>(() => {})
		const onOutOfRange = mock<(typed: number, bounds: { min: number; max: number }) => void>(
			() => {},
		)
		render(
			<OversellDeltaField value={5} onChange={onChange} max={100} onOutOfRange={onOutOfRange} />,
		)
		const input = screen.getByRole('spinbutton') as HTMLInputElement
		fireEvent.blur(input, { target: { value: '999' } })
		expect(onOutOfRange).toHaveBeenCalledWith(999, { min: -1000, max: 100 })
		expect(onChange).not.toHaveBeenCalled() // NO silent mutation
	})

	// ============== Adversarial ==============

	it('[A1] disabled does NOT call onChange on +/− click', async () => {
		const onChange = mock<(v: number) => void>(() => {})
		render(<OversellDeltaField value={0} onChange={onChange} disabled={true} />)
		// userEvent.click respects pointer-events:none on disabled buttons
		const plus = screen.getByRole('button', { name: 'Увеличить овербукинг' })
		expect((plus as HTMLButtonElement).disabled).toBe(true)
		// Force click via fireEvent — even then onChange not called (disabled handler short-circuits)
		fireEvent.click(plus)
		expect(onChange).not.toHaveBeenCalled()
	})

	it('[A2] value === min: decrement disabled, increment enabled', () => {
		render(<OversellDeltaField value={-1000} onChange={() => {}} min={-1000} max={1000} />)
		expect(
			(screen.getByRole('button', { name: 'Уменьшить овербукинг' }) as HTMLButtonElement).disabled,
		).toBe(true)
		expect(
			(screen.getByRole('button', { name: 'Увеличить овербукинг' }) as HTMLButtonElement).disabled,
		).toBe(false)
	})

	it('[A3] value === max: increment disabled, decrement enabled', () => {
		render(<OversellDeltaField value={1000} onChange={() => {}} min={-1000} max={1000} />)
		expect(
			(screen.getByRole('button', { name: 'Уменьшить овербукинг' }) as HTMLButtonElement).disabled,
		).toBe(false)
		expect(
			(screen.getByRole('button', { name: 'Увеличить овербукинг' }) as HTMLButtonElement).disabled,
		).toBe(true)
	})
})

describe('<OversellDeltaBadge>', () => {
	it('[BD1] value=0 → null (no badge)', () => {
		const { container } = render(<OversellDeltaBadge value={0} />)
		expect(container.querySelector('[data-slot="oversell-delta-badge"]')).toBeNull()
	})

	it('[BD2] positive value → amber color + «+N» text', () => {
		const { container } = render(<OversellDeltaBadge value={2} />)
		const badge = container.querySelector('[data-slot="oversell-delta-badge"]')
		expect(badge).not.toBeNull()
		expect(badge?.getAttribute('data-sign')).toBe('positive')
		expect(badge?.className).toContain('amber')
		expect(badge?.textContent).toContain('+2')
	})

	it('[BD3] negative value → rose color + minus prefix', () => {
		const { container } = render(<OversellDeltaBadge value={-1} />)
		const badge = container.querySelector('[data-slot="oversell-delta-badge"]')
		expect(badge?.getAttribute('data-sign')).toBe('negative')
		expect(badge?.className).toContain('rose')
		// RU locale uses U+2212 (minus) not U+002D (hyphen)
		expect(badge?.textContent).toMatch(/[−-]1/u)
	})
})
