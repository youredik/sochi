import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Outlet, redirect, useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'
import { LogoutButton } from '../features/auth/components/logout-button.tsx'
import { OrgSwitcher } from '../features/tenancy/components/org-switcher.tsx'
import { authClient, sessionQueryOptions } from '../lib/auth-client.ts'
import { subscribeAuthBroadcasts } from '../lib/broadcast-auth.ts'

/**
 * Authenticated shell. Pathless layout (`_app.tsx`) — does NOT consume a
 * URL segment, so child route `/o/$orgSlug/...` is still reachable as
 * `/o/{slug}/...` while this layout's beforeLoad gate runs.
 *
 * Behaviour:
 *   1. No session → redirect to /login with `?redirect=<current>` so we
 *      can bounce them back after sign-in
 *   2. Session exists but no `activeOrganizationId` → try to set first
 *      org as active (stankoff-v2 "org onboarding in guard" pattern),
 *      or send to /o-select if multiple orgs, or to /signup if zero
 *   3. All set → render the authenticated chrome (top bar + Outlet)
 *
 * Mounted-side: subscribe to cross-tab BroadcastChannel messages so a
 * logout or org-switch in a peer tab propagates here instantly — without
 * waiting for the next server 401 via QueryCache.
 */
export const Route = createFileRoute('/_app')({
	beforeLoad: async ({ context, location }) => {
		const session = await context.queryClient.ensureQueryData(sessionQueryOptions)
		if (!session?.session) {
			throw redirect({ to: '/login', search: { redirect: location.href } })
		}
		if (!session.session.activeOrganizationId) {
			const res = await authClient.organization.list()
			const orgs = res.data ?? []
			if (orgs.length === 0) {
				// Edge case: session but no org (should not happen for fresh signup).
				// Defensive — send to signup to re-create; alternative would be a
				// dedicated /org/new but первый этап держит signup as the single creation path.
				throw redirect({ to: '/signup' })
			}
			if (orgs.length === 1) {
				const firstOrg = orgs[0]
				if (!firstOrg) throw redirect({ to: '/signup' })
				await authClient.organization.setActive({ organizationId: firstOrg.id })
				await context.queryClient.invalidateQueries({ queryKey: sessionQueryOptions.queryKey })
				throw redirect({
					to: '/o/$orgSlug',
					params: { orgSlug: firstOrg.slug },
					reloadDocument: true,
				})
			}
			throw redirect({ to: '/o-select' })
		}
		return { session }
	},
	component: AppLayout,
})

function AppLayout() {
	const queryClient = useQueryClient()
	const router = useRouter()

	useEffect(
		() =>
			subscribeAuthBroadcasts({
				onLogout: () => {
					void queryClient.invalidateQueries({ queryKey: sessionQueryOptions.queryKey })
					void router.navigate({ to: '/login', search: { redirect: undefined } })
				},
				onOrgChange: (_organizationId, slug) => {
					void queryClient.invalidateQueries({ queryKey: sessionQueryOptions.queryKey })
					void router.navigate({ to: '/o/$orgSlug', params: { orgSlug: slug } })
				},
			}),
		[queryClient, router],
	)

	return (
		<div className="flex min-h-screen flex-col">
			<header className="border-b border-border bg-background/80 backdrop-blur">
				<div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
					<span className="text-sm font-semibold tracking-tight text-foreground">HoReCa</span>
					<div className="flex items-center gap-4">
						<OrgSwitcher />
						<LogoutButton />
					</div>
				</div>
			</header>
			<div className="flex-1">
				<Outlet />
			</div>
		</div>
	)
}
