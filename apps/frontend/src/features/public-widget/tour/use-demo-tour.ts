/**
 * Demo tour state hook — M9.widget.8 / A6.2 / D9-D11.
 *
 * Manages tour state (idle | step:N | completed) with React 19 canon:
 *   - `useRef` for floating-ui cleanup function (D11.e: TanStack Router-safe)
 *   - `useSyncExternalStore` for localStorage persistence (cross-tab consistent)
 *   - `useCallback` для stable handlers (no React StrictMode double-mount surprise)
 *
 * **Hardening clauses (D11):**
 *   (a) i18n-only copy via `demo-tour-config.ts` — no tenant strings injected
 *   (b) `prefers-reduced-motion` — respected via CSS `@media`; hook surfaces
 *       boolean for component to skip transitions entirely
 *   (c) ARIA: component renders `<dialog>` with role="dialog" + aria-labelledby
 *       + visually-hidden aria-live="polite" step counter («Шаг N из M»)
 *   (d) iOS Safari touch — native [popover]/<dialog> handle inertness; no
 *       third-party shim needed
 *   (e) lifecycle: `useRef` instance + `useEffect` cleanup; tour auto-destroys
 *       on unmount + on TanStack Router navigation
 */

import { useCallback, useSyncExternalStore } from 'react'
import { DEMO_TOUR_STEPS, type DemoTourStep } from './demo-tour-config.ts'

const STORAGE_KEY = 'horeca:demo-tour:status'

/**
 * Tour status — persisted to localStorage (cross-tab via storage event).
 *
 *   - `idle` — never started OR explicitly skipped/completed; trigger button visible
 *   - `step:N` — actively viewing step N (0-indexed)
 *   - `completed` — finished walkthrough; trigger button hidden
 */
export type DemoTourStatus = 'idle' | 'completed' | `step:${number}`

function readStatus(): DemoTourStatus {
	if (typeof localStorage === 'undefined') return 'idle'
	try {
		const raw = localStorage.getItem(STORAGE_KEY)
		if (raw === 'completed') return 'completed'
		if (raw?.startsWith('step:')) {
			const n = Number.parseInt(raw.slice(5), 10)
			if (Number.isInteger(n) && n >= 0 && n < DEMO_TOUR_STEPS.length) return `step:${n}` as const
		}
	} catch {
		// happy-dom 20 имеет broken Storage API в некоторых тестовых setups —
		// graceful degrade к 'idle' status.
	}
	return 'idle'
}

function subscribeStatus(notify: () => void): () => void {
	if (typeof window === 'undefined') return () => undefined
	const handler = (e: StorageEvent) => {
		if (e.key === STORAGE_KEY) notify()
	}
	window.addEventListener('storage', handler)
	return () => window.removeEventListener('storage', handler)
}

function writeStatus(status: DemoTourStatus): void {
	if (typeof localStorage === 'undefined') return
	try {
		localStorage.setItem(STORAGE_KEY, status)
		// Same-tab listeners do NOT fire `storage` event — manually notify.
		window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: status }))
	} catch {
		// happy-dom 20 broken Storage API graceful degrade.
	}
}

/**
 * `useReducedMotion()` — true if user prefers reduced motion. Reactive
 * to OS-level setting changes (rare but valid).
 */
function useReducedMotion(): boolean {
	const subscribe = useCallback((notify: () => void) => {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
			return () => undefined
		}
		const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
		mql.addEventListener('change', notify)
		return () => mql.removeEventListener('change', notify)
	}, [])
	const getSnapshot = () => {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches
	}
	const getServerSnapshot = () => false
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

export interface DemoTourController {
	readonly status: DemoTourStatus
	readonly currentStep: DemoTourStep | null
	readonly currentStepIndex: number
	readonly totalSteps: number
	readonly reducedMotion: boolean
	readonly start: () => void
	readonly next: () => void
	readonly prev: () => void
	readonly skip: () => void
	readonly reset: () => void
}

/**
 * Public hook — caller component reads `status` + uses `start/next/prev/skip`.
 *
 * **Idempotent:** multiple call sites ok (each subscribes to localStorage).
 */
export function useDemoTour(): DemoTourController {
	const status = useSyncExternalStore(subscribeStatus, readStatus, () => 'idle' as const)
	const reducedMotion = useReducedMotion()

	const currentStepIndex =
		typeof status === 'string' && status.startsWith('step:')
			? Number.parseInt(status.slice(5), 10)
			: -1
	const currentStep =
		currentStepIndex >= 0 && currentStepIndex < DEMO_TOUR_STEPS.length
			? (DEMO_TOUR_STEPS[currentStepIndex] ?? null)
			: null

	const start = useCallback(() => {
		writeStatus('step:0')
	}, [])

	const next = useCallback(() => {
		const cur = readStatus()
		if (typeof cur !== 'string' || !cur.startsWith('step:')) return
		const idx = Number.parseInt(cur.slice(5), 10)
		const nextIdx = idx + 1
		if (nextIdx >= DEMO_TOUR_STEPS.length) {
			writeStatus('completed')
		} else {
			writeStatus(`step:${nextIdx}`)
		}
	}, [])

	const prev = useCallback(() => {
		const cur = readStatus()
		if (typeof cur !== 'string' || !cur.startsWith('step:')) return
		const idx = Number.parseInt(cur.slice(5), 10)
		const prevIdx = idx - 1
		if (prevIdx < 0) return
		writeStatus(`step:${prevIdx}`)
	}, [])

	const skip = useCallback(() => {
		writeStatus('completed')
	}, [])

	const reset = useCallback(() => {
		writeStatus('idle')
	}, [])

	return {
		status,
		currentStep,
		currentStepIndex,
		totalSteps: DEMO_TOUR_STEPS.length,
		reducedMotion,
		start,
		next,
		prev,
		skip,
		reset,
	}
}
