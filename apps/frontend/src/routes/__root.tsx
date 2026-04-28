import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'

/**
 * Root route context. `queryClient` is injected by `createRouter(...)` in
 * main.tsx; child routes read it in their `beforeLoad` guards via
 * `context.queryClient.ensureQueryData(...)` — canonical 2026 pattern for
 * auth-gated TanStack Router layouts.
 */
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
	component: RootLayout,
})

function RootLayout() {
	return (
		<div className="min-h-svh">
			<Outlet />
		</div>
	)
}
