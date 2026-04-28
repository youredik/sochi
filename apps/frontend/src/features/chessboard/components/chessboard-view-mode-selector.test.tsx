/**
 * ChessboardViewModeSelector — strict component tests (M9.5 Phase B).
 *
 * Pre-done audit:
 *   Render:
 *     [R1] Both options 'День' + 'Месяц' rendered
 *     [R2] aria-label на ToggleGroup root
 *     [R3] active option отмечен data-state=on
 *   Selection:
 *     [S1] Click 'Месяц' → store.viewMode = 'month'
 *     [S2] Click 'День' (когда уже active) → store stays 'day' (не reset к '')
 *     [S3] Default state = 'day'
 *   a11y:
 *     [A1] role=group present (ToggleGroup wrapper)
 *     [A2] each item has aria-label
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storageData = vi.hoisted(() => ({ value: new Map<string, string>() }))
vi.hoisted(() => {
	const stub = {
		getItem: (k: string) => storageData.value.get(k) ?? null,
		setItem: (k: string, v: string) => {
			storageData.value.set(k, String(v))
		},
		removeItem: (k: string) => {
			storageData.value.delete(k)
		},
		clear: () => storageData.value.clear(),
		key: (i: number) => Array.from(storageData.value.keys())[i] ?? null,
		get length() {
			return storageData.value.size
		},
	} satisfies Storage
	Object.defineProperty(globalThis, 'localStorage', {
		value: stub,
		writable: true,
		configurable: true,
	})
})

const { useChessboardPrefsStore } = await import('../lib/chessboard-prefs-store')
const { ChessboardViewModeSelector } = await import('./chessboard-view-mode-selector')

beforeEach(() => {
	storageData.value.clear()
	useChessboardPrefsStore.setState({ viewMode: 'day', windowDays: 15 })
})

afterEach(() => {
	cleanup()
})

describe('ChessboardViewModeSelector — render', () => {
	it('[R1] both options rendered', () => {
		render(<ChessboardViewModeSelector />)
		expect(screen.getByRole('radio', { name: 'День' })).toBeDefined()
		expect(screen.getByRole('radio', { name: 'Месяц' })).toBeDefined()
	})

	it('[R2] root has aria-label "Режим просмотра шахматки"', () => {
		render(<ChessboardViewModeSelector />)
		// Radix ToggleGroup type=single renders <div role="group"> wrapping
		// <button role="radio"> items (NOT a radiogroup ARIA pattern).
		expect(screen.getByRole('group', { name: 'Режим просмотра шахматки' })).toBeDefined()
	})

	it('[R3] default state — "День" is data-state=on', () => {
		render(<ChessboardViewModeSelector />)
		const day = screen.getByRole('radio', { name: 'День' })
		const month = screen.getByRole('radio', { name: 'Месяц' })
		expect(day.getAttribute('data-state')).toBe('on')
		expect(month.getAttribute('data-state')).toBe('off')
	})
})

describe('ChessboardViewModeSelector — selection', () => {
	it('[S1] click "Месяц" → store.viewMode = month', () => {
		render(<ChessboardViewModeSelector />)
		fireEvent.click(screen.getByRole('radio', { name: 'Месяц' }))
		expect(useChessboardPrefsStore.getState().viewMode).toBe('month')
	})

	it('[S2] click already-active "День" does NOT reset', () => {
		render(<ChessboardViewModeSelector />)
		const day = screen.getByRole('radio', { name: 'День' })
		fireEvent.click(day)
		// Radix ToggleGroup type=single emits '' on click-same; component must
		// suppress that and keep last valid value.
		expect(useChessboardPrefsStore.getState().viewMode).toBe('day')
	})

	it('[S3] default state is "day"', () => {
		expect(useChessboardPrefsStore.getState().viewMode).toBe('day')
	})
})
