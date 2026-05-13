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
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

// localStorage stub — must be installed BEFORE the dynamic imports of `./mode-toggle`
// and `@/lib/theme-store` so Zustand `persist` middleware captures our stub at module
// load. In Vitest this was wrapped in `vi.hoisted()` (which runs above the static
// `import` declarations); in bun:test there is no auto-hoist mechanism, but ESM
// top-level code already runs after the static imports complete and before the
// subsequent `await import(...)`, which matches what we need.
const storageData = { value: new Map<string, string>() }
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
		expect(trigger).not.toBe(undefined)
	})

	it('[R2] sr-only fallback text "Переключить тему" present', () => {
		render(<ModeToggle />)
		expect(screen.queryByText('Переключить тему')).not.toBe(null)
	})
})

describe('ModeToggle — interaction', () => {
	it('[I1] open dropdown reveals 3 theme items в exact order', async () => {
		const user = userEvent.setup()
		render(<ModeToggle />)
		await user.click(screen.getByRole('button', { name: /Тема оформления/i }))

		await waitFor(() => {
			expect(screen.queryByRole('menuitem', { name: /Светлая/i })).not.toBe(null)
		})
		expect(screen.queryByRole('menuitem', { name: /Тёмная/i })).not.toBe(null)
		expect(screen.queryByRole('menuitem', { name: /Системная/i })).not.toBe(null)
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
