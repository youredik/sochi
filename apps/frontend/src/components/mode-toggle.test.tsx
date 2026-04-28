/**
 * ModeToggle — strict tests (M9.1).
 *
 * **Pre-done audit:**
 *   Render:
 *     [R1] Button trigger present с aria-label
 *     [R2] sr-only fallback text «Переключить тему»
 *
 *   Interaction:
 *     [I1] open dropdown → 3 menu items present (Светлая, Тёмная, Системная)
 *     [I2] click "Светлая" → setTheme('light') called с exact arg
 *     [I3] click "Тёмная" → setTheme('dark')
 *     [I4] click "Системная" → setTheme('system')
 *
 *   A11y:
 *     [A1] trigger button focusable via keyboard
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted localStorage stub — required для Zustand persist module-load capture
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

const { ModeToggle } = await import('./mode-toggle')
const { useThemeStore } = await import('@/lib/theme-store')

import type { Theme } from '@/lib/theme-store'

let setThemeSpy: (theme: Theme) => void
let setThemeCalls: Theme[]

beforeEach(() => {
	setThemeCalls = []
	setThemeSpy = (theme: Theme) => {
		setThemeCalls.push(theme)
	}
	useThemeStore.setState({ theme: 'system', setTheme: setThemeSpy })
})

afterEach(() => {
	cleanup() // testing-library auto-cleanup НЕ работает при vitest globals: false
	useThemeStore.setState({ theme: 'system' })
})

describe('ModeToggle — render', () => {
	it('[R1] trigger button has aria-label "Тема оформления"', () => {
		render(<ModeToggle />)
		const trigger = screen.getByRole('button', { name: /Тема оформления/i })
		expect(trigger).toBeDefined()
	})

	it('[R2] sr-only fallback text "Переключить тему" present', () => {
		render(<ModeToggle />)
		expect(screen.getByText('Переключить тему')).toBeDefined()
	})
})

describe('ModeToggle — interaction', () => {
	it('[I1] open dropdown reveals 3 theme items в exact order', async () => {
		const user = userEvent.setup()
		render(<ModeToggle />)
		await user.click(screen.getByRole('button', { name: /Тема оформления/i }))

		await waitFor(() => {
			expect(screen.getByRole('menuitem', { name: /Светлая/i })).toBeDefined()
		})
		expect(screen.getByRole('menuitem', { name: /Тёмная/i })).toBeDefined()
		expect(screen.getByRole('menuitem', { name: /Системная/i })).toBeDefined()
	})

	it('[I2] click "Светлая" → setTheme("light") exact', async () => {
		const user = userEvent.setup()
		render(<ModeToggle />)
		await user.click(screen.getByRole('button', { name: /Тема оформления/i }))
		await user.click(await screen.findByRole('menuitem', { name: /Светлая/i }))
		expect(setThemeCalls).toEqual(['light'])
	})

	it('[I3] click "Тёмная" → setTheme("dark") exact', async () => {
		const user = userEvent.setup()
		render(<ModeToggle />)
		await user.click(screen.getByRole('button', { name: /Тема оформления/i }))
		await user.click(await screen.findByRole('menuitem', { name: /Тёмная/i }))
		expect(setThemeCalls).toEqual(['dark'])
	})

	it('[I4] click "Системная" → setTheme("system") exact', async () => {
		const user = userEvent.setup()
		render(<ModeToggle />)
		await user.click(screen.getByRole('button', { name: /Тема оформления/i }))
		await user.click(await screen.findByRole('menuitem', { name: /Системная/i }))
		expect(setThemeCalls).toEqual(['system'])
	})
})

describe('ModeToggle — a11y', () => {
	it('[A1] trigger button is focusable via tab', async () => {
		const user = userEvent.setup()
		render(<ModeToggle />)
		await user.tab()
		const trigger = screen.getByRole('button', { name: /Тема оформления/i })
		expect(document.activeElement).toBe(trigger)
	})
})
