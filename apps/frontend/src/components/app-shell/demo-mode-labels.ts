/**
 * Canonical Russian labels for the `[DEMO]` / `[LIVE]` pill rendered by
 * `<DemoModeBadge>` (`demo-mode-badge.tsx`).
 *
 * Lives in its own module so `demo-mode-badge.tsx` can stay component-only
 * (Vite Fast Refresh canon, biome `useComponentExportOnlyModules` —
 * mixed component + non-component exports break HMR; same canon documented
 * in `feedback_form_pattern_rule.md` for related extraction patterns).
 */
import type { TenantMode } from '@horeca/shared'

export const DEMO_MODE_BADGE_LABELS: Readonly<
	Record<TenantMode, { display: string; ariaLabel: string }>
> = Object.freeze({
	demo: { display: 'ДЕМО', ariaLabel: 'Демо-режим' },
	production: { display: 'LIVE', ariaLabel: 'Продакшн-режим' },
})
