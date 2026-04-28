/**
 * ChessboardWindowSelector — strict tests (M9.3).
 *
 * **Pre-done audit:**
 *   Render:
 *     [R1] trigger button has aria-label "Размер окна Шахматки"
 *     [R2] visible label показывает current windowDays value (default "15 дней")
 *
 *   Interaction:
 *     [I1] open dropdown → 5 options visible (3/7/15/30/fit) в exact order
 *     [I2] click "3 дня" → store.setWindowDays(3) called atomically
 *     [I3] click "7 дней" → store=7
 *     [I4] click "30 дней" → store=30
 *     [I5] click "По ширине экрана" → store='fit' (string preserved)
 *
 *   A11y:
 *     [A1] active option has aria-current="true"
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
		clear: () => {
			storageData.value.clear()
		},
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

const { ChessboardWindowSelector } = await import('./chessboard-window-selector')
const { useChessboardPrefsStore } = await import('../lib/chessboard-prefs-store')

beforeEach(() => {
	storageData.value.clear()
	useChessboardPrefsStore.setState({ windowDays: 15, viewMode: 'day' })
})

afterEach(() => {
	cleanup()
})

describe('ChessboardWindowSelector — render', () => {
	it('[R1] trigger button has aria-label "Размер окна Шахматки"', () => {
		render(<ChessboardWindowSelector />)
		const trigger = screen.getByRole('button', { name: /Размер окна/i })
		expect(trigger).toBeDefined()
	})

	it('[R2] visible label = "15 дней" по default', () => {
		render(<ChessboardWindowSelector />)
		expect(screen.getByText('15 дней')).toBeDefined()
	})

	it('[R2.b] visible label sync с store change', () => {
		useChessboardPrefsStore.setState({ windowDays: 7 })
		render(<ChessboardWindowSelector />)
		expect(screen.getByText('7 дней')).toBeDefined()
	})
})

describe('ChessboardWindowSelector — interaction', () => {
	it('[I1] dropdown reveals 5 options в Bnovo-parity order', async () => {
		const user = userEvent.setup()
		render(<ChessboardWindowSelector />)
		await user.click(screen.getByRole('button', { name: /Размер окна/i }))
		const items = await screen.findAllByRole('menuitem')
		expect(items).toHaveLength(5)
		expect(items[0]?.textContent).toContain('3 дня')
		expect(items[1]?.textContent).toContain('7 дней')
		expect(items[2]?.textContent).toContain('15 дней')
		expect(items[3]?.textContent).toContain('30 дней')
		expect(items[4]?.textContent).toContain('По ширине экрана')
	})

	it('[I2] click "3 дня" → store windowDays=3', async () => {
		const user = userEvent.setup()
		render(<ChessboardWindowSelector />)
		await user.click(screen.getByRole('button', { name: /Размер окна/i }))
		await user.click(await screen.findByRole('menuitem', { name: /3 дня/i }))
		expect(useChessboardPrefsStore.getState().windowDays).toBe(3)
	})

	it('[I3] click "7 дней" → store=7', async () => {
		const user = userEvent.setup()
		render(<ChessboardWindowSelector />)
		await user.click(screen.getByRole('button', { name: /Размер окна/i }))
		await user.click(await screen.findByRole('menuitem', { name: /^7 дней$/ }))
		expect(useChessboardPrefsStore.getState().windowDays).toBe(7)
	})

	it('[I4] click "30 дней" → store=30', async () => {
		const user = userEvent.setup()
		render(<ChessboardWindowSelector />)
		await user.click(screen.getByRole('button', { name: /Размер окна/i }))
		await user.click(await screen.findByRole('menuitem', { name: /30 дней/i }))
		expect(useChessboardPrefsStore.getState().windowDays).toBe(30)
	})

	it('[I5] click "По ширине экрана" → store="fit" (string preserved)', async () => {
		const user = userEvent.setup()
		render(<ChessboardWindowSelector />)
		await user.click(screen.getByRole('button', { name: /Размер окна/i }))
		await user.click(await screen.findByRole('menuitem', { name: /По ширине экрана/i }))
		expect(useChessboardPrefsStore.getState().windowDays).toBe('fit')
	})
})

describe('ChessboardWindowSelector — a11y', () => {
	it('[A1] active option (windowDays=15 default) has aria-current="true"', async () => {
		const user = userEvent.setup()
		render(<ChessboardWindowSelector />)
		await user.click(screen.getByRole('button', { name: /Размер окна/i }))
		const active = await screen.findByRole('menuitem', { name: /15 дней/i })
		expect(active.getAttribute('aria-current')).toBe('true')
	})
})
