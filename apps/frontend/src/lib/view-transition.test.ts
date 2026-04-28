/**
 * view-transition — strict tests (M9.1).
 *
 * **Pre-done audit:**
 *   [V1] No-API browser → fn() called sync, не throw
 *   [V2] reduce-motion=true → fn() called sync (bypass API)
 *   [V3] reduce-motion=false + API present → startViewTransition wraps fn
 *   [V4] fn invoked ровно один раз (no double-call)
 *   [V5] fn errors don't crash wrapper — propagate normally (caller handles)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { viewTransitionApply } from './view-transition'

let originalStartViewTransition: typeof document.startViewTransition | undefined
let matchMediaSpy: ReturnType<typeof vi.spyOn>

function mockReducedMotion(reduce: boolean) {
	matchMediaSpy.mockImplementation((query: string) => {
		const matches = query === '(prefers-reduced-motion: reduce)' ? reduce : false
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

beforeEach(() => {
	originalStartViewTransition = document.startViewTransition
	matchMediaSpy = vi.spyOn(window, 'matchMedia')
})

afterEach(() => {
	if (originalStartViewTransition) {
		;(
			document as unknown as { startViewTransition: typeof originalStartViewTransition }
		).startViewTransition = originalStartViewTransition
	} else {
		// happy-dom не имеет startViewTransition — если spyOn не set'ил, удаляем mock
		Reflect.deleteProperty(document, 'startViewTransition')
	}
	matchMediaSpy.mockRestore()
})

describe('viewTransitionApply', () => {
	it('[V1] no startViewTransition API → fn called synchronously', () => {
		mockReducedMotion(false)
		Reflect.deleteProperty(document, 'startViewTransition')
		const fn = vi.fn()
		viewTransitionApply(fn)
		expect(fn).toHaveBeenCalledTimes(1)
	})

	it('[V2] reduce-motion=true → fn called sync (API bypassed)', () => {
		mockReducedMotion(true)
		const startSpy = vi.fn(() => ({
			ready: Promise.resolve(),
			finished: Promise.resolve(),
			updateCallbackDone: Promise.resolve(),
			skipTransition: vi.fn(),
		}))
		;(document as unknown as { startViewTransition: typeof startSpy }).startViewTransition =
			startSpy
		const fn = vi.fn()
		viewTransitionApply(fn)
		expect(fn).toHaveBeenCalledTimes(1)
		expect(startSpy).not.toHaveBeenCalled()
	})

	it('[V3] reduce-motion=false + API present → startViewTransition wraps fn', () => {
		mockReducedMotion(false)
		const startSpy = vi.fn((cb: () => void) => {
			cb()
			return {
				ready: Promise.resolve(),
				finished: Promise.resolve(),
				updateCallbackDone: Promise.resolve(),
				skipTransition: vi.fn(),
			}
		})
		;(document as unknown as { startViewTransition: typeof startSpy }).startViewTransition =
			startSpy
		const fn = vi.fn()
		viewTransitionApply(fn)
		expect(startSpy).toHaveBeenCalledTimes(1)
		expect(fn).toHaveBeenCalledTimes(1)
	})

	it('[V4] fn invoked exactly once (not double-called)', () => {
		mockReducedMotion(false)
		const startSpy = vi.fn((cb: () => void) => {
			cb()
			return {
				ready: Promise.resolve(),
				finished: Promise.resolve(),
				updateCallbackDone: Promise.resolve(),
				skipTransition: vi.fn(),
			}
		})
		;(document as unknown as { startViewTransition: typeof startSpy }).startViewTransition =
			startSpy
		const fn = vi.fn()
		viewTransitionApply(fn)
		expect(fn).toHaveBeenCalledTimes(1)
	})

	it('[V5] fn throwing propagates — wrapper не глотает errors', () => {
		mockReducedMotion(true)
		const fn = vi.fn(() => {
			throw new Error('boom')
		})
		expect(() => viewTransitionApply(fn)).toThrow('boom')
	})
})
