/**
 * DemoModeBadge — `[DEMO]` / `[LIVE]` pill mounted in `<SidebarFooter>`.
 *
 * Plan canon `plans/track-a-bis-canonical.md` §4 D31 / §6 architecture.
 * Operational visibility for the always-on demo strategy
 * (`project_demo_strategy.md` 2026-04-28): single deployment serves both
 * demo prospects and production tenants — operators must see at a glance
 * which mode the active org is in.
 *
 * Driven by `useTenantMode()` (server-resolved from `organizationProfile.mode`,
 * exposed via `/api/v1/me` after A.bis.2 C36 enrichment).
 *
 * Render contract:
 *   - mode loading (undefined) → render nothing (no flash, no layout shift)
 *   - mode = 'demo'             → amber pill «ДЕМО» + aria-label «Демо-режим»
 *   - mode = 'production'       → emerald pill «LIVE» + aria-label «Продакшн-режим»
 *
 * a11y (per plan §12):
 *   - `<span role="status" aria-live="polite">` so screen-readers announce
 *     mode flips politely on session refresh
 *   - explicit Cyrillic aria-label (D15 canon — never English fallthrough)
 */
import { useTenantMode } from '@/lib/use-can'
import { cn } from '@/lib/utils'
import { DEMO_MODE_BADGE_LABELS } from './demo-mode-labels'

export function DemoModeBadge() {
	const mode = useTenantMode()
	if (mode === undefined) return null
	const { display, ariaLabel } = DEMO_MODE_BADGE_LABELS[mode]
	return (
		<span
			data-slot="demo-mode-badge"
			data-mode={mode}
			role="status"
			aria-live="polite"
			aria-label={ariaLabel}
			className={cn(
				'inline-flex items-center justify-center rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
				// Forced-colors-aware contrast canon (project_axe_a11y_gate.md): on
				// HCM, `bg-[Highlight]` / `text-[HighlightText]` keeps the pill
				// visible even though our amber/emerald palette flattens.
				'forced-colors:bg-[Highlight] forced-colors:text-[HighlightText] forced-colors:border forced-colors:border-[ButtonText]',
				mode === 'demo'
					? 'bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200'
					: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-200',
			)}
		>
			{display}
		</span>
	)
}
