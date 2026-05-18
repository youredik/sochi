import { type RefObject, useCallback, useSyncExternalStore } from 'react'
import { DAY_COLUMN_MIN_WIDTH, ROW_HEADER_WIDTH } from '../lib/layout'

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
 * Defaults pull from `lib/layout` constants — single source of truth per
 * G11 v3.3 fix (2026-05-18). Pre-fix duplicated `180` / `40` literals в
 * 3 sites caused fit-math vs CSS-grid drift.
 *
 * @param containerRef — div ref за чьим offsetWidth следим
 * @param rowHeaderWidth — sticky col-header width (px), default ROW_HEADER_WIDTH
 * @param minDayWidth — min cell width (px), default DAY_COLUMN_MIN_WIDTH
 * @returns numeric days count (≥3, ≤60), defaults к 15 на SSR / pre-mount
 */
export function useFitWindowDays(
	containerRef: RefObject<HTMLElement | null>,
	rowHeaderWidth = ROW_HEADER_WIDTH,
	minDayWidth = DAY_COLUMN_MIN_WIDTH,
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
