/**
 * theme-provider — strict tests (M9.1).
 *
 * **Pre-done audit:**
 *   Apply theme to <html>:
 *     [T1] theme='light' → no .dark class
 *     [T2] theme='dark' → .dark class added
 *     [T3] theme='system' + OS=dark → .dark class added
 *     [T4] theme='system' + OS=light → no .dark class
 *
 *   meta theme-color sync:
 *     [C1] theme='dark' → no-media meta.content === '#0a0a0a'
 *     [C2] theme='light' → no-media meta.content === '#ffffff'
 *     [C3] theme='system' → no-media meta has NO content attr (восстанавливаем static fallback)
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted localStorage stub — required для Zustand persist module-load capture
// (happy-dom 20.9 broken Storage API в vitest env)
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
const { ThemeProvider } = await import('./theme-provider')

let originalHtml: HTMLElement
let matchMediaSpy: ReturnType<typeof vi.spyOn>

function mockSystemTheme(dark: boolean) {
	matchMediaSpy.mockImplementation((query: string) => {
		const matches = query === '(prefers-color-scheme: dark)' ? dark : false
		return {
			matches,
			media: query,
			onchange: null,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(),
		} as MediaQueryList
	})
}

function setupMetaThemeColor() {
	// Add no-media <meta name="theme-color"> в head — то же что в index.html
	const meta = document.createElement('meta')
	meta.name = 'theme-color'
	document.head.appendChild(meta)
	return meta
}

beforeEach(() => {
	originalHtml = document.documentElement
	matchMediaSpy = vi.spyOn(window, 'matchMedia')
	document.documentElement.classList.remove('dark')
	useThemeStore.setState({ theme: 'system' })
	// Clear any leftover theme-color meta
	for (const m of document.querySelectorAll('meta[name="theme-color"]:not([media])')) {
		m.remove()
	}
})

afterEach(() => {
	cleanup() // testing-library auto-cleanup НЕ работает при vitest globals: false
	matchMediaSpy.mockRestore()
	document.documentElement.classList.remove('dark')
	for (const m of document.querySelectorAll('meta[name="theme-color"]:not([media])')) {
		m.remove()
	}
})

describe('ThemeProvider — apply theme to <html>', () => {
	it('[T1] theme="light" → no .dark class', () => {
		mockSystemTheme(false)
		useThemeStore.setState({ theme: 'light' })
		render(
			<ThemeProvider>
				<div />
			</ThemeProvider>,
		)
		expect(originalHtml.classList.contains('dark')).toBe(false)
	})

	it('[T2] theme="dark" → .dark class present', () => {
		mockSystemTheme(false)
		useThemeStore.setState({ theme: 'dark' })
		render(
			<ThemeProvider>
				<div />
			</ThemeProvider>,
		)
		expect(originalHtml.classList.contains('dark')).toBe(true)
	})

	it('[T3] theme="system" + OS=dark → .dark class present', () => {
		mockSystemTheme(true)
		useThemeStore.setState({ theme: 'system' })
		render(
			<ThemeProvider>
				<div />
			</ThemeProvider>,
		)
		expect(originalHtml.classList.contains('dark')).toBe(true)
	})

	it('[T4] theme="system" + OS=light → no .dark class', () => {
		mockSystemTheme(false)
		useThemeStore.setState({ theme: 'system' })
		render(
			<ThemeProvider>
				<div />
			</ThemeProvider>,
		)
		expect(originalHtml.classList.contains('dark')).toBe(false)
	})
})

describe('ThemeProvider — meta theme-color sync', () => {
	it('[C1] theme="dark" → meta content === "#0a0a0a"', () => {
		const meta = setupMetaThemeColor()
		mockSystemTheme(false)
		useThemeStore.setState({ theme: 'dark' })
		render(
			<ThemeProvider>
				<div />
			</ThemeProvider>,
		)
		expect(meta.getAttribute('content')).toBe('#0a0a0a')
	})

	it('[C2] theme="light" → meta content === "#ffffff"', () => {
		const meta = setupMetaThemeColor()
		mockSystemTheme(true)
		useThemeStore.setState({ theme: 'light' })
		render(
			<ThemeProvider>
				<div />
			</ThemeProvider>,
		)
		expect(meta.getAttribute('content')).toBe('#ffffff')
	})

	it('[C3] theme="system" → meta has no content attr (static fallback active)', () => {
		const meta = setupMetaThemeColor()
		meta.setAttribute('content', '#cccccc') // pre-populate
		mockSystemTheme(false)
		useThemeStore.setState({ theme: 'system' })
		render(
			<ThemeProvider>
				<div />
			</ThemeProvider>,
		)
		expect(meta.hasAttribute('content')).toBe(false)
	})
})
