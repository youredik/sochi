/**
 * ErrorState — strict tests (M9.5).
 *
 * **Pre-done audit:**
 *   Render:
 *     [R1] role="alert" present (screen reader announce)
 *     [R2] default title «Что-то пошло не так»
 *     [R3] custom title overrides default
 *     [R4] error.message в <details> когда provided
 *     [R5] details collapsed by default
 *     [R6] retry button rendered ТОЛЬКО когда onRetry provided
 *     [R7] retry button click invokes callback once
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorState } from './error-state'

afterEach(() => {
	cleanup()
})

describe('ErrorState — render', () => {
	it('[R1] role="alert" present', () => {
		render(<ErrorState />)
		expect(screen.getByRole('alert')).toBeDefined()
	})

	it('[R2] default title "Что-то пошло не так"', () => {
		render(<ErrorState />)
		expect(screen.getByText('Что-то пошло не так')).toBeDefined()
	})

	it('[R3] custom title overrides default', () => {
		render(<ErrorState title="Custom error" />)
		expect(screen.getByText('Custom error')).toBeDefined()
		expect(screen.queryByText('Что-то пошло не так')).toBeNull()
	})

	it('[R4] error.message в <details> when provided', () => {
		const err = new Error('boom')
		render(<ErrorState error={err} />)
		expect(screen.getByText('Подробнее')).toBeDefined()
		expect(screen.getByText('boom')).toBeDefined()
	})

	it('[R5] details collapsed by default', () => {
		const err = new Error('boom')
		render(<ErrorState error={err} />)
		const details = document.querySelector('details')
		expect(details).not.toBeNull()
		expect(details?.open).toBe(false)
	})

	it('[R6] retry button absent when no onRetry', () => {
		render(<ErrorState />)
		expect(screen.queryByRole('button', { name: /Повторить/ })).toBeNull()
	})

	it('[R7] retry button click invokes callback once', async () => {
		const calls: number[] = []
		const onRetry = () => {
			calls.push(Date.now())
		}
		render(<ErrorState onRetry={onRetry} />)
		const user = userEvent.setup()
		await user.click(screen.getByRole('button', { name: /Повторить/ }))
		expect(calls).toHaveLength(1)
	})
})
