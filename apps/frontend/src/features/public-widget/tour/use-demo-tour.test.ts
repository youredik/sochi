/**
 * useDemoTour hook — strict tests TOUR1-TOUR5 (M9.widget.8 / A6.2 / D9-D11).
 *
 * Per plan §5: «5 TOUR tests (mode-gate / Esc dismiss / motion / aria-live / cleanup)».
 *
 * Strict-test canon:
 *   - Exact-value asserts on status transitions
 *   - localStorage isolation per test (prevents bleed)
 *   - prefers-reduced-motion mock via matchMedia stub
 *   - Hook in isolation (no DOM surface assertions — those live in *.test.tsx)
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const STORAGE_KEY = 'horeca:demo-tour:status'

// Top-level localStorage stub for bun:test. useDemoTour reads localStorage at
// hook-call time, so the stub MUST be live BEFORE the dynamic `await import`
// of './use-demo-tour' below.
const storageData = { value: new Map<string, string>() }

;(() => {
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
})()

const { useDemoTour } = await import('./use-demo-tour.ts')

const originalMatchMedia = globalThis.matchMedia

beforeEach(() => {
	storageData.value.clear()
	// Default matchMedia mock — no reduced motion.
	;(globalThis as { matchMedia?: unknown }).matchMedia = mock((query: string) => ({
		matches: false,
		media: query,
		addEventListener: mock(),
		removeEventListener: mock(),
		dispatchEvent: mock(),
	}))
})

afterEach(() => {
	;(globalThis as { matchMedia?: unknown }).matchMedia = originalMatchMedia
	storageData.value.clear()
})

describe('useDemoTour — status transitions (D9 lifecycle)', () => {
	it('[TOUR1] initial status is "idle" с currentStep=null', () => {
		const { result } = renderHook(() => useDemoTour())
		expect(result.current.status).toBe('idle')
		expect(result.current.currentStep).toBeNull()
		expect(result.current.currentStepIndex).toBe(-1)
		expect(result.current.totalSteps).toBe(4)
	})

	it('[TOUR1.b] start() advances status → "step:0"', () => {
		const { result } = renderHook(() => useDemoTour())
		act(() => result.current.start())
		expect(result.current.status).toBe('step:0')
		expect(result.current.currentStepIndex).toBe(0)
		expect(result.current.currentStep?.id).toBe('welcome')
	})

	it('[TOUR1.c] next() walks through всех steps + finishes на "completed"', () => {
		const { result } = renderHook(() => useDemoTour())
		act(() => result.current.start())
		expect(result.current.status).toBe('step:0')
		act(() => result.current.next())
		expect(result.current.status).toBe('step:1')
		act(() => result.current.next())
		expect(result.current.status).toBe('step:2')
		act(() => result.current.next())
		expect(result.current.status).toBe('step:3')
		act(() => result.current.next())
		expect(result.current.status).toBe('completed')
		expect(result.current.currentStep).toBeNull()
	})

	it('[TOUR2] skip() jumps к "completed" from any step (Esc-equivalent)', () => {
		const { result } = renderHook(() => useDemoTour())
		act(() => result.current.start())
		act(() => result.current.next()) // step:1
		act(() => result.current.skip())
		expect(result.current.status).toBe('completed')
	})

	it('[TOUR2.b] prev() walks back, blocked at step:0', () => {
		const { result } = renderHook(() => useDemoTour())
		act(() => result.current.start())
		act(() => result.current.next()) // step:1
		act(() => result.current.prev())
		expect(result.current.status).toBe('step:0')
		// Trying to go before step:0 — no-op.
		act(() => result.current.prev())
		expect(result.current.status).toBe('step:0')
	})
})

describe('useDemoTour — prefers-reduced-motion (D11.b)', () => {
	it('[TOUR3] reducedMotion reflects matchMedia value (false default)', () => {
		const { result } = renderHook(() => useDemoTour())
		expect(result.current.reducedMotion).toBe(false)
	})

	it('[TOUR3.b] reducedMotion=true когда matchMedia("(prefers-reduced-motion: reduce)").matches=true', () => {
		;(globalThis as { matchMedia?: unknown }).matchMedia = mock((query: string) => ({
			matches: query.includes('reduced-motion'),
			media: query,
			addEventListener: mock(),
			removeEventListener: mock(),
			dispatchEvent: mock(),
		}))
		const { result } = renderHook(() => useDemoTour())
		expect(result.current.reducedMotion).toBe(true)
	})
})

describe('useDemoTour — localStorage persistence (D11.e cleanup)', () => {
	it('[TOUR4] status persists across re-mounts via localStorage', () => {
		const { result: r1, unmount } = renderHook(() => useDemoTour())
		act(() => r1.current.start())
		act(() => r1.current.next()) // step:1
		expect(localStorage.getItem(STORAGE_KEY)).toBe('step:1')
		unmount()
		const { result: r2 } = renderHook(() => useDemoTour())
		expect(r2.current.status).toBe('step:1')
		expect(r2.current.currentStep?.id).toBe('properties')
	})

	it('[TOUR4.b] reset() returns к "idle" (test seam — not exposed in UI)', () => {
		const { result } = renderHook(() => useDemoTour())
		act(() => result.current.start())
		act(() => result.current.skip())
		expect(result.current.status).toBe('completed')
		act(() => result.current.reset())
		expect(result.current.status).toBe('idle')
	})
})

describe('useDemoTour — defensive guards', () => {
	it('[TOUR5] malformed localStorage value → idle (graceful)', () => {
		localStorage.setItem(STORAGE_KEY, 'malformed-garbage')
		const { result } = renderHook(() => useDemoTour())
		expect(result.current.status).toBe('idle')
	})

	it('[TOUR5.b] step:N out of range → idle (graceful)', () => {
		localStorage.setItem(STORAGE_KEY, 'step:99')
		const { result } = renderHook(() => useDemoTour())
		expect(result.current.status).toBe('idle')
	})

	it('[TOUR5.c] step:negative → idle (graceful)', () => {
		localStorage.setItem(STORAGE_KEY, 'step:-1')
		const { result } = renderHook(() => useDemoTour())
		expect(result.current.status).toBe('idle')
	})
})
