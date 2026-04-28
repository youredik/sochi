import { type RefObject, useCallback, useSyncExternalStore } from 'react'

/**
 * useFitWindowDays — runtime resolves `windowDays === 'fit'` к computed
 * numeric days count via `ResizeObserver` (M9.5 Phase B Bnovo-parity).
 *
 * Modern React 18+ canonical: `useSyncExternalStore` для external subscribed
 * sources. SSR-safe (server snapshot returns fallback) + concurrent-mode-safe
 * + tearing-free (всегда consistent с DOM measurement за один пейнт).
 *
 * Formula per plan §M9.3:
 *   `Math.floor((containerWidth - rowHeaderWidth) / minDayWidth)`, clamped
 *   к [3, 60] для предотвращения 0/negative + extreme widths.
 *
 * @param containerRef — div ref за чьим offsetWidth следим
 * @param rowHeaderWidth — sticky col-header width (px), default 180
 * @param minDayWidth — min cell width (px), default 40
 * @returns numeric days count (≥3, ≤60), defaults к 15 на SSR / pre-mount
 */
export function useFitWindowDays(
	containerRef: RefObject<HTMLElement | null>,
	rowHeaderWidth = 180,
	minDayWidth = 40,
): number {
	const subscribe = useCallback(
		(notify: () => void) => {
			const el = containerRef.current
			if (!el) return () => {}
			const ro = new ResizeObserver(() => notify())
			ro.observe(el)
			return () => ro.disconnect()
		},
		[containerRef],
	)

	const getSnapshot = useCallback(() => {
		const el = containerRef.current
		if (!el) return 15
		const available = el.offsetWidth - rowHeaderWidth
		const fit = Math.floor(available / minDayWidth)
		return Math.max(3, Math.min(60, fit))
	}, [containerRef, rowHeaderWidth, minDayWidth])

	// SSR snapshot — same fallback as initial mount; hydration-safe.
	const getServerSnapshot = useCallback(() => 15, [])

	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
