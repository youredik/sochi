/**
 * View Transition wrapper для theme switch.
 *
 * Critical: View Transitions API НЕ респектит `prefers-reduced-motion`
 * автоматически (Chrome devs blog 2026 «View Transitions Misconceptions» — React
 * тоже не делает auto-disable). Manual guard обязателен — иначе motion-sensitive
 * users видят cross-fade flash при theme switch.
 *
 * Graceful fallback: browsers без `document.startViewTransition` (Firefox <137,
 * old Safari) — apply theme synchronously без анимации. WICG spec deliberately
 * progressive enhancement.
 *
 * Не использовать React 19 `<ViewTransition>` (experimental React Labs 2025-04,
 * не Baseline) — browser API напрямую стабильнее (Round 4 self-audit decision).
 */
export function viewTransitionApply(fn: () => void): void {
	const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
	if (reduce || typeof document.startViewTransition !== 'function') {
		fn()
		return
	}
	document.startViewTransition(fn)
}
