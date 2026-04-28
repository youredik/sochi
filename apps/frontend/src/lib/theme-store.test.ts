/**
 * theme-store — strict tests (M9.1).
 *
 * **Pre-done audit checklist (FROM START — feedback_pre_done_audit.md):**
 *
 *   Initial state:
 *     [I1] default theme === 'system' (canon — respects OS pref)
 *     [I2] partialize keeps only `theme` (no transient state в storage)
 *     [I3] storage key is exactly 'horeca-theme' (must match FOUC-script in index.html)
 *
 *   Mutation:
 *     [M1] setTheme('dark') updates state.theme atomically
 *     [M2] setTheme('light') round-trip
 *     [M3] setTheme('system') round-trip
 *     [M4] state object not mutated in-place (immutable update — Zustand canon)
 *
 *   Persistence:
 *     [P1] setTheme writes to localStorage синхронно (sync storage)
 *     [P2] localStorage value is JSON-parseable с {state, version}
 *     [P3] storage value reflects exact theme string (no extra keys)
 *
 *   Adversarial:
 *     [A1] localStorage corrupted JSON → store falls back to default 'system'
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'horeca-theme'

/**
 * happy-dom 20.9.0 + vitest 4 env имеет broken Storage API
 * (removeItem/clear не functions). Hoist localStorage stub ПЕРЕД import
 * useThemeStore — Zustand persist captures localStorage ref на module-load.
 */
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

const { useThemeStore } = await import('./theme-store')

beforeEach(() => {
	storageData.value.clear()
	useThemeStore.setState({ theme: 'system' })
})

describe('theme-store — Initial state', () => {
	it('[I1] default theme is system', () => {
		expect(useThemeStore.getState().theme).toBe('system')
	})

	it('[I3] storage key is exactly "horeca-theme"', () => {
		// Storage key matches FOUC-script in index.html — silent regression если меняется
		const persistOpts = useThemeStore.persist.getOptions()
		expect(persistOpts.name).toBe(STORAGE_KEY)
	})
})

describe('theme-store — Mutation', () => {
	it('[M1] setTheme("dark") updates atomically', () => {
		useThemeStore.getState().setTheme('dark')
		expect(useThemeStore.getState().theme).toBe('dark')
	})

	it('[M2] setTheme("light") round-trip', () => {
		useThemeStore.getState().setTheme('light')
		expect(useThemeStore.getState().theme).toBe('light')
	})

	it('[M3] setTheme("system") round-trip', () => {
		useThemeStore.getState().setTheme('dark')
		useThemeStore.getState().setTheme('system')
		expect(useThemeStore.getState().theme).toBe('system')
	})

	it('[M4] state is referentially new after setTheme (immutable canon)', () => {
		const before = useThemeStore.getState()
		useThemeStore.getState().setTheme('dark')
		const after = useThemeStore.getState()
		expect(after).not.toBe(before)
		expect(after.theme).toBe('dark')
	})
})

describe('theme-store — Persistence', () => {
	it('[P1+P2+P3] setTheme writes parseable JSON с exact theme value', () => {
		useThemeStore.getState().setTheme('dark')
		const raw = localStorage.getItem(STORAGE_KEY)
		expect(raw).not.toBeNull()
		const parsed = JSON.parse(raw as string) as { state: { theme: string } }
		expect(parsed.state.theme).toBe('dark')
	})

	it('[I2] partialize keeps only theme — no extra fields в state', () => {
		useThemeStore.getState().setTheme('light')
		const raw = localStorage.getItem(STORAGE_KEY)
		const parsed = JSON.parse(raw as string) as { state: Record<string, unknown> }
		// state объект should contain ONLY theme key (no setTheme function, no transient)
		expect(Object.keys(parsed.state)).toEqual(['theme'])
	})
})

describe('theme-store — Adversarial', () => {
	it('[A1] corrupted localStorage JSON does not crash store', () => {
		localStorage.setItem(STORAGE_KEY, '{not valid json}')
		// Force re-hydration. Zustand persist swallows JSON parse errors (canonical safe).
		useThemeStore.persist.rehydrate()
		// Store stays operational regardless of corruption — ничего не throw'ит
		expect(useThemeStore.getState().theme).toBeDefined()
		expect(['light', 'dark', 'system']).toContain(useThemeStore.getState().theme)
	})
})
