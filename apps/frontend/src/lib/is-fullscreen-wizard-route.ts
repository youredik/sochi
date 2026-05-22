/**
 * Detect whether the current pathname belongs к a fullscreen onboarding-wizard
 * route — used by `_app.tsx` to hide sidebar + AdminShell chrome during setup.
 *
 * Why segment-aware instead of `endsWith('/setup')`: the latter misses sub-
 * routes (`/o/foo/setup/identify`, `/o/foo/setup/inventory`) that may live
 * under setup в будущем. We want the wizard fullscreen mode active for the
 * ENTIRE setup subtree, not just the index.
 *
 * Why a dedicated helper: lets the rule be unit-tested cheaply без TanStack
 * Router mount (which needs a full Provider). The pathname-only contract also
 * keeps the rule pure / deterministic — no router runtime dependency.
 */
export function isFullscreenWizardRoute(pathname: string): boolean {
	return pathname.split('/').includes('setup')
}
