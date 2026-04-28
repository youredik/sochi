/**
 * install-prompt — strict tests (M9.4).
 *
 * **Pre-done audit:**
 *   Store:
 *     [I1] default dismissed === false
 *     [I2] storage key === 'horeca-install-prompt'
 *     [M1] dismiss() updates atomically
 *     [P1] partialize keeps only `dismissed`
 *
 *   Detection helpers:
 *     [D1] isIosSafari() — true для iPhone Safari UA, false для Chrome iOS / Firefox iOS
 *     [D2] isStandalone() — true когда display-mode standalone matches OR
 *           navigator.standalone === true
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'horeca-install-prompt'

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

const { useInstallPromptStore, isIosSafari, isStandalone } = await import('./install-prompt')

beforeEach(() => {
	storageData.value.clear()
	useInstallPromptStore.setState({ dismissed: false })
})

describe('install-prompt store', () => {
	it('[I1] default dismissed === false', () => {
		expect(useInstallPromptStore.getState().dismissed).toBe(false)
	})

	it('[I2] storage key === "horeca-install-prompt"', () => {
		expect(useInstallPromptStore.persist.getOptions().name).toBe(STORAGE_KEY)
	})

	it('[M1] dismiss() updates atomically', () => {
		useInstallPromptStore.getState().dismiss()
		expect(useInstallPromptStore.getState().dismissed).toBe(true)
	})

	it('[P1] partialize keeps only dismissed', () => {
		useInstallPromptStore.getState().dismiss()
		const raw = localStorage.getItem(STORAGE_KEY)
		expect(raw).not.toBeNull()
		const parsed = JSON.parse(raw as string) as { state: Record<string, unknown> }
		expect(Object.keys(parsed.state)).toEqual(['dismissed'])
	})
})

describe('isIosSafari detection', () => {
	let uaSpy: ReturnType<typeof vi.spyOn>

	afterEach(() => {
		uaSpy?.mockRestore()
	})

	function mockUA(ua: string) {
		uaSpy = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua)
	}

	it('[D1.a] iPhone Safari → true', () => {
		mockUA(
			'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
		)
		expect(isIosSafari()).toBe(true)
	})

	it('[D1.b] Chrome on iOS (CriOS) → false', () => {
		mockUA(
			'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1',
		)
		expect(isIosSafari()).toBe(false)
	})

	it('[D1.c] Firefox on iOS (FxiOS) → false', () => {
		mockUA(
			'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/120.0 Mobile/15E148 Safari/604.1',
		)
		expect(isIosSafari()).toBe(false)
	})

	it('[D1.d] Desktop Chrome → false', () => {
		mockUA(
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
		)
		expect(isIosSafari()).toBe(false)
	})
})

describe('isStandalone detection', () => {
	let mqSpy: ReturnType<typeof vi.spyOn>
	let stdSpy: ReturnType<typeof vi.spyOn> | undefined

	afterEach(() => {
		mqSpy?.mockRestore()
		stdSpy?.mockRestore?.()
	})

	function mockMatchMedia(matches: boolean) {
		mqSpy = vi.spyOn(window, 'matchMedia').mockImplementation(
			() =>
				({
					matches,
					media: '(display-mode: standalone)',
					onchange: null,
					addListener: vi.fn(),
					removeListener: vi.fn(),
					addEventListener: vi.fn(),
					removeEventListener: vi.fn(),
					dispatchEvent: vi.fn(),
				}) as MediaQueryList,
		)
	}

	it('[D2.a] display-mode standalone → true', () => {
		mockMatchMedia(true)
		expect(isStandalone()).toBe(true)
	})

	it('[D2.b] не standalone и нет navigator.standalone → false', () => {
		mockMatchMedia(false)
		expect(isStandalone()).toBe(false)
	})
})
