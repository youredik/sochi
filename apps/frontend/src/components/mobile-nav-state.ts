import { useState } from 'react'

/**
 * useMobileNavMore — controlled state для More-button → SidebarDrawer toggle.
 *
 * Extracted hook (separate file от mobile-nav.tsx) — биome
 * `useComponentExportOnlyModules` rule требует component-only modules для
 * fast-refresh integrity. Hook + Component в одном файле = warning.
 *
 * Single source of truth: _app.tsx mount'ит SidebarDrawer один раз; multiple
 * MobileNav instances (теоретически SSR pre-render) не дублируют drawers.
 */
export function useMobileNavMore() {
	const [open, setOpen] = useState(false)
	return { open, setOpen, onMoreClick: () => setOpen(true) }
}
