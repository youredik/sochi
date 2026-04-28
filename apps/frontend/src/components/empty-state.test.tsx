/**
 * EmptyState — strict tests (M9.5).
 *
 * **Pre-done audit:**
 *   Render:
 *     [R1] title rendered as h3 hierarchy
 *     [R2] description rendered when provided
 *     [R3] description hidden when not provided
 *     [R4] icon rendered с aria-hidden="true"
 *     [R5] action rendered when provided (ReactNode slot)
 *     [R6] action hidden when null
 */
import { cleanup, render, screen } from '@testing-library/react'
import { CalendarRangeIcon } from 'lucide-react'
import { afterEach, describe, expect, it } from 'vitest'
import { EmptyState } from './empty-state'

afterEach(() => {
	cleanup()
})

describe('EmptyState — render', () => {
	it('[R1] title rendered as h3', () => {
		render(<EmptyState title="No data" />)
		const h3 = screen.getByRole('heading', { level: 3 })
		expect(h3.textContent).toBe('No data')
	})

	it('[R2] description rendered when provided', () => {
		render(<EmptyState title="Empty" description="Nothing here yet." />)
		expect(screen.getByText('Nothing here yet.')).toBeDefined()
	})

	it('[R3] description hidden when not provided', () => {
		render(<EmptyState title="Empty" />)
		expect(screen.queryByText(/Nothing/)).toBeNull()
	})

	it('[R4] icon rendered c aria-hidden="true"', () => {
		render(<EmptyState title="Empty" icon={CalendarRangeIcon} />)
		const svg = document.querySelector('svg')
		expect(svg).not.toBeNull()
		expect(svg?.getAttribute('aria-hidden')).toBe('true')
	})

	it('[R5] action rendered when provided', () => {
		render(<EmptyState title="Empty" action={<button type="button">Create</button>} />)
		expect(screen.getByRole('button', { name: 'Create' })).toBeDefined()
	})

	it('[R6] action absent when null', () => {
		render(<EmptyState title="Empty" />)
		expect(screen.queryByRole('button')).toBeNull()
	})
})
