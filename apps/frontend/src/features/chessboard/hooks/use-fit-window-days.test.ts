/**
 * useFitWindowDays — strict hook tests (M9.5 Phase B).
 *
 * Pre-done audit:
 *   [F1] containerRef.current === null → returns 15 (SSR/pre-mount fallback)
 *   [F2] container width 800px, header 180, minDay 40 → floor((800-180)/40) = 15
 *   [F3] container width 1200px → floor((1200-180)/40) = 25
 *   [F4] container width 200px → clamped к min 3 (NOT 0 / 1)
 *   [F5] container width 5000px → clamped к max 60
 *   [F6] custom rowHeaderWidth=200 + minDayWidth=50 → applied correctly
 *   [F7] resize mutation → returned value updates (ResizeObserver subscription)
 */
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useFitWindowDays } from './use-fit-window-days'

class MockResizeObserver {
	callback: ResizeObserverCallback
	target: Element | null = null
	static instances: MockResizeObserver[] = []
	constructor(cb: ResizeObserverCallback) {
		this.callback = cb
		MockResizeObserver.instances.push(this)
	}
	observe(t: Element) {
		this.target = t
	}
	disconnect() {
		this.target = null
	}
	unobserve() {}
	trigger() {
		if (!this.target) return
		this.callback(
			[
				{
					target: this.target,
					contentRect: this.target.getBoundingClientRect(),
				} as ResizeObserverEntry,
			],
			this as unknown as ResizeObserver,
		)
	}
}

const ORIGINAL_RO = globalThis.ResizeObserver

afterEach(() => {
	MockResizeObserver.instances = []
	globalThis.ResizeObserver = ORIGINAL_RO
	vi.restoreAllMocks()
})

function makeRef(width: number) {
	const el = document.createElement('div')
	Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true, writable: true })
	return { current: el } as { current: HTMLElement | null }
}

describe('useFitWindowDays', () => {
	it('[F1] null container → returns 15 (fallback)', () => {
		globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
		const ref = { current: null } as { current: HTMLElement | null }
		const { result } = renderHook(() => useFitWindowDays(ref))
		expect(result.current).toBe(15)
	})

	it('[F2] width 800 → 15 days', () => {
		globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
		const ref = makeRef(800)
		const { result } = renderHook(() => useFitWindowDays(ref))
		expect(result.current).toBe(15) // (800-180)/40 = 15.5 → 15
	})

	it('[F3] width 1200 → 25 days', () => {
		globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
		const ref = makeRef(1200)
		const { result } = renderHook(() => useFitWindowDays(ref))
		expect(result.current).toBe(25) // (1200-180)/40 = 25.5 → 25
	})

	it('[F4] width 200 → clamped к min 3', () => {
		globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
		const ref = makeRef(200)
		const { result } = renderHook(() => useFitWindowDays(ref))
		// (200-180)/40 = 0.5 → 0 → clamped к 3
		expect(result.current).toBe(3)
	})

	it('[F5] width 5000 → clamped к max 60', () => {
		globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
		const ref = makeRef(5000)
		const { result } = renderHook(() => useFitWindowDays(ref))
		// (5000-180)/40 = 120 → clamped к 60
		expect(result.current).toBe(60)
	})

	it('[F6] custom rowHeaderWidth + minDayWidth applied', () => {
		globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
		const ref = makeRef(1000)
		const { result } = renderHook(() => useFitWindowDays(ref, 200, 50))
		// (1000-200)/50 = 16
		expect(result.current).toBe(16)
	})

	it('[F7] resize re-evaluates → snapshot updates', async () => {
		globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
		const ref = makeRef(800)
		const { result } = renderHook(() => useFitWindowDays(ref))
		expect(result.current).toBe(15)

		// Mutate width + trigger ResizeObserver callback.
		Object.defineProperty(ref.current!, 'offsetWidth', { value: 1200, configurable: true })
		MockResizeObserver.instances[0]!.trigger()

		await waitFor(() => {
			expect(result.current).toBe(25)
		})
	})
})
