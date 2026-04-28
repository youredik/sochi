import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Outlet, redirect, useParams, useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'
import { InstallPrompt } from '../components/install-prompt.tsx'
import { MobileNav } from '../components/mobile-nav.tsx'
import { useMobileNavMore } from '../components/mobile-nav-state.ts'
import { ModeToggle } from '../components/mode-toggle.tsx'
import { SidebarDrawer } from '../components/sidebar-drawer.tsx'
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
	const params = useParams({ strict: false })
	const orgSlug = params.orgSlug as string | undefined
	const mobileNav = useMobileNavMore()

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
		<div className="flex min-h-svh flex-col">
			{/*
			 * Top header — sticky на mobile + desktop. Mobile показывает только
			 * brand + ModeToggle (OrgSwitcher/Logout уехали в SidebarDrawer
			 * под More-tab); desktop (md+) сохраняет existing layout полностью.
			 * pt-safe-top — для iOS PWA standalone (notch/Dynamic Island).
			 */}
			<header className="border-b border-border bg-background/80 pt-safe-top sticky top-0 z-40 backdrop-blur">
				<div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 md:px-6">
					<span className="text-sm font-semibold tracking-tight text-foreground">HoReCa</span>
					<div className="flex items-center gap-2">
						<div className="hidden md:block">
							<OrgSwitcher />
						</div>
						<ModeToggle />
						<div className="hidden md:block">
							<LogoutButton />
						</div>
					</div>
				</div>
			</header>
			{/*
			 * Outlet — pb-20 на mobile (запас под bottom-nav 64px высота),
			 * pb-0 desktop. flex-1 заполняет verticai space между header и
			 * bottom-nav.
			 */}
			<div className="flex-1 pb-20 md:pb-0">
				<Outlet />
			</div>
			{/*
			 * Bottom-tab + SidebarDrawer — только при наличии orgSlug (вне
			 * o-select / signup). Drawer mounted один раз — multiple MobileNav
			 * instances невозможны (single AppLayout per app).
			 */}
			{orgSlug ? (
				<>
					<MobileNav orgSlug={orgSlug} onMoreClick={mobileNav.onMoreClick} />
					<SidebarDrawer orgSlug={orgSlug} open={mobileNav.open} onOpenChange={mobileNav.setOpen} />
				</>
			) : null}
			{/* PWA install hint (mobile только, dismissable, persists). */}
			<InstallPrompt />
		</div>
	)
}
