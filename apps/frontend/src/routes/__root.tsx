import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import { maybeRedirectToAppHost } from '../lib/apex-redirect.ts'

/**
 * Root route context. `queryClient` is injected by `createRouter(...)` in
 * main.tsx; child routes read it in their `beforeLoad` guards via
 * `context.queryClient.ensureQueryData(...)` — canonical 2026 pattern for
 * auth-gated TanStack Router layouts.
 *
 * **Apex-redirect canon 2026-05-21**: single source-of-truth для apex →
 * demo subdomain redirect lives here. Every route navigation fires this
 * guard first; helper returns `false` для marketing paths (`/`, `/privacy`,
 * `/legal/*`) и для non-apex hostnames (no-op). Per
 * `[[feedback_self_review_finds_halfmeasure]]` — one check beats per-route
 * duplication.
 */
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
	beforeLoad: async () => {
		const apex = maybeRedirectToAppHost()
		if (apex) await apex
	},
	component: RootLayout,
})

function RootLayout() {
	return (
		<div className="min-h-svh">
			<Outlet />
		</div>
	)
}
