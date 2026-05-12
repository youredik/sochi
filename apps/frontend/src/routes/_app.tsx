import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Outlet, redirect, useParams, useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'
import { AdminSidebar } from '../components/app-shell/admin-sidebar.tsx'
import { InstallPrompt } from '../components/install-prompt.tsx'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '../components/ui/sidebar.tsx'
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
 *   3. All set → render the authenticated chrome (sidebar app-shell + Outlet)
 *
 * App-shell (A.bis.2): single `<SidebarProvider>` (D14 canon — multiple
 * providers share cookie + Cmd+B per shadcn-ui/ui#9335; PATCH-D14 in
 * `ui/sidebar.tsx` enforces dev-only). `<AdminSidebar>` mounts когда
 * `orgSlug` resolved (route guard guarantees it for tenant-scoped paths).
 * Mobile (<768 px) gets a minimal top-bar with `<SidebarTrigger>` —
 * canonical shadcn pattern (no auto-hamburger; explicit trigger required
 * per §6 architecture diagram + §16 C26).
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
	const params = useParams({ strict: false })
	const orgSlug = params.orgSlug as string | undefined

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
		<SidebarProvider defaultOpen>
			{orgSlug ? <AdminSidebar orgSlug={orgSlug} /> : null}
			<SidebarInset>
				{/*
				 * Minimal mobile top-bar (md:hidden) — explicit <SidebarTrigger>
				 * mount per shadcn canon §6 + plan §16 C26. Brand label kept на
				 * правой стороне для recognizability. Desktop (md+) скрывает —
				 * <SidebarHeader> внутри AdminSidebar содержит OrgSwitcher.
				 * pt-safe-top — iOS PWA standalone notch / Dynamic Island.
				 */}
				{orgSlug ? (
					<header className="border-border bg-background/80 pt-safe-top sticky top-0 z-40 flex items-center justify-between border-b px-4 py-3 backdrop-blur md:hidden">
						<SidebarTrigger aria-label="Открыть меню" />
						<span className="text-sm font-semibold tracking-tight">HoReCa</span>
					</header>
				) : null}
				<Outlet />
				{/* PWA install hint (mobile only, dismissable, persists). */}
				<InstallPrompt />
			</SidebarInset>
		</SidebarProvider>
	)
}
