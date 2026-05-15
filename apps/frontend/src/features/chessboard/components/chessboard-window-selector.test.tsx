/**
 * ChessboardWindowSelector — strict tests (M9.3 + G6 Cloudbeds extension 2026-05-15).
 *
 * **Pre-done audit:**
 *   Render:
 *     [R1] trigger button has aria-label "Размер окна Шахматки"
 *     [R2] visible label показывает current windowDays value (default "15 дней")
 *     [R3] G6 — visible label «1 неделя» когда windowDays=7 (RU morphology)
 *     [R4] G6 — visible label «2 недели» когда windowDays=14
 *
 *   Interaction:
 *     [I1] open dropdown → 8 options visible (3/4/7/14/15/21/30/fit) в exact order
 *     [I2] click "3 дня" → store.setWindowDays(3)
 *     [I3] click "1 неделя" → store=7 (Cloudbeds w1 alias)
 *     [I4] click "30 дней" → store=30
 *     [I5] click "По ширине экрана" → store='fit'
 *     [I6] G6 — click "4 дня" → store=4
 *     [I7] G6 — click "2 недели" → store=14
 *     [I8] G6 — click "3 недели" → store=21
 *
 *   A11y:
 *     [A1] active option has aria-current="true"
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

// G6.bis (2026-05-15) — flake fix: см. parallel canon в `chessboard-prefs-
// store.test.ts`. Was installing file-local localStorage stub which collided
// с the twin stub в the prefs-store test (whichever loaded last overwrote
// globalThis.localStorage, breaking storage state isolation between specs
// в sequential runs). Now using happy-dom's native window.localStorage.
const { ChessboardWindowSelector } = await import('./chessboard-window-selector')
const { useChessboardPrefsStore } = await import('../lib/chessboard-prefs-store')

beforeEach(() => {
	window.localStorage.clear()
	useChessboardPrefsStore.setState({ windowDays: 15, viewMode: 'day' })
})

afterEach(() => {
	cleanup()
})

describe('ChessboardWindowSelector — render', () => {
	it('[R1] trigger button has aria-label "Размер окна Шахматки"', () => {
		render(<ChessboardWindowSelector />)
		const trigger = screen.getByRole('button', { name: /Размер окна/i })
		expect(trigger).not.toBe(undefined)
	})

	it('[R2] visible label = "15 дней" по default', () => {
		render(<ChessboardWindowSelector />)
		expect(screen.queryByText('15 дней')).not.toBe(null)
	})

	it('[R2.b] visible label sync с store change', () => {
		useChessboardPrefsStore.setState({ windowDays: 30 })
		render(<ChessboardWindowSelector />)
		expect(screen.queryByText('30 дней')).not.toBe(null)
	})

	it('[R3] G6 — visible label "1 неделя" когда windowDays=7 (Cloudbeds canon)', () => {
		useChessboardPrefsStore.setState({ windowDays: 7 })
		render(<ChessboardWindowSelector />)
		expect(screen.queryByText('1 неделя')).not.toBe(null)
	})

	it('[R4] G6 — visible label "2 недели" когда windowDays=14', () => {
		useChessboardPrefsStore.setState({ windowDays: 14 })
		render(<ChessboardWindowSelector />)
		expect(screen.queryByText('2 недели')).not.toBe(null)
	})

	it('[R5] G6 — visible label "3 недели" когда windowDays=21', () => {
		useChessboardPrefsStore.setState({ windowDays: 21 })
		render(<ChessboardWindowSelector />)
		expect(screen.queryByText('3 недели')).not.toBe(null)
	})

	it('[R6] G6 — visible label "4 дня" когда windowDays=4', () => {
		useChessboardPrefsStore.setState({ windowDays: 4 })
		render(<ChessboardWindowSelector />)
		expect(screen.queryByText('4 дня')).not.toBe(null)
	})
})

describe('ChessboardWindowSelector — interaction', () => {
	it('[I1] G6 — dropdown reveals 8 options в Bnovo + Cloudbeds canonical order', async () => {
		const user = userEvent.setup()
		render(<ChessboardWindowSelector />)
		await user.click(screen.getByRole('button', { name: /Размер окна/i }))
		const items = await screen.findAllByRole('menuitem')
		expect(items).toHaveLength(8)
		expect(items[0]?.textContent).toContain('3 дня')
		expect(items[1]?.textContent).toContain('4 дня')
		expect(items[2]?.textContent).toContain('1 неделя')
		expect(items[3]?.textContent).toContain('2 недели')
		expect(items[4]?.textContent).toContain('15 дней')
		expect(items[5]?.textContent).toContain('3 недели')
		expect(items[6]?.textContent).toContain('30 дней')
		expect(items[7]?.textContent).toContain('По ширине экрана')
	})

	it('[I2] click "3 дня" → store windowDays=3', async () => {
		const user = userEvent.setup()
		render(<ChessboardWindowSelector />)
		await user.click(screen.getByRole('button', { name: /Размер окна/i }))
		await user.click(await screen.findByRole('menuitem', { name: /3 дня/i }))
		expect(useChessboardPrefsStore.getState().windowDays).toBe(3)
	})

	it('[I3] G6 — click "1 неделя" → store=7 (Cloudbeds w1 alias)', async () => {
		const user = userEvent.setup()
		render(<ChessboardWindowSelector />)
		await user.click(screen.getByRole('button', { name: /Размер окна/i }))
		await user.click(await screen.findByRole('menuitem', { name: /1 неделя/i }))
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

	it('[I6] G6 — click "4 дня" → store=4 (Cloudbeds quick-view)', async () => {
		const user = userEvent.setup()
		render(<ChessboardWindowSelector />)
		await user.click(screen.getByRole('button', { name: /Размер окна/i }))
		await user.click(await screen.findByRole('menuitem', { name: /4 дня/i }))
		expect(useChessboardPrefsStore.getState().windowDays).toBe(4)
	})

	it('[I7] G6 — click "2 недели" → store=14', async () => {
		const user = userEvent.setup()
		render(<ChessboardWindowSelector />)
		await user.click(screen.getByRole('button', { name: /Размер окна/i }))
		await user.click(await screen.findByRole('menuitem', { name: /2 недели/i }))
		expect(useChessboardPrefsStore.getState().windowDays).toBe(14)
	})

	it('[I8] G6 — click "3 недели" → store=21', async () => {
		const user = userEvent.setup()
		render(<ChessboardWindowSelector />)
		await user.click(screen.getByRole('button', { name: /Размер окна/i }))
		await user.click(await screen.findByRole('menuitem', { name: /3 недели/i }))
		expect(useChessboardPrefsStore.getState().windowDays).toBe(21)
	})

	it('[I9] G6 — backward-compat: 15-day option still works (legacy persisted value)', async () => {
		const user = userEvent.setup()
		useChessboardPrefsStore.setState({ windowDays: 7 })
		render(<ChessboardWindowSelector />)
		await user.click(screen.getByRole('button', { name: /Размер окна/i }))
		await user.click(await screen.findByRole('menuitem', { name: /15 дней/i }))
		expect(useChessboardPrefsStore.getState().windowDays).toBe(15)
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
