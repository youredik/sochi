import { useQueryClient } from '@tanstack/react-query'
import {
	createFileRoute,
	Outlet,
	redirect,
	useLocation,
	useParams,
	useRouter,
} from '@tanstack/react-router'
import { useEffect } from 'react'
import { AdminSidebar } from '../components/app-shell/admin-sidebar.tsx'
import { InstallPrompt } from '../components/install-prompt.tsx'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '../components/ui/sidebar.tsx'
import { orgListQueryOptions } from '../features/tenancy/hooks/use-active-org.ts'
import { authClient, sessionQueryOptions } from '../lib/auth-client.ts'
import { subscribeAuthBroadcasts } from '../lib/broadcast-auth.ts'
import { isFullscreenWizardRoute } from '../lib/is-fullscreen-wizard-route.ts'

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
			const orgs = await context.queryClient.ensureQueryData(orgListQueryOptions)
			if (orgs.length === 0) {
				// Session + zero orgs is the canonical post-magic-link-verify state
				// under the passwordless canon (commit `3b0b486`): BA's verify
				// callback ALWAYS lands users here briefly because org creation
				// happens AFTER session is established, in `/welcome`. Reached via
				// two flows:
				//   • /signup → magic-link → /welcome?n=<orgName>  (carries name)
				//   • /login  → magic-link → /  (JIT user via `disableSignUp:false`)
				// Both converge on `/welcome` — the dedicated org-creation surface.
				// Sending к `/signup` instead would ping-pong because /signup's
				// inverse guard bounces signed-in users back to /.
				throw redirect({ to: '/welcome', search: { n: undefined } })
			}
			if (orgs.length === 1) {
				const firstOrg = orgs[0]
				// length===1 guarantees orgs[0] exists; this branch satisfies
				// TS's `noUncheckedIndexedAccess` and is defensively re-routed
				// to /welcome rather than asserting non-null.
				if (!firstOrg) throw redirect({ to: '/welcome', search: { n: undefined } })
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
	const location = useLocation()
	const orgSlug = params.orgSlug
	// `/setup` subtree — onboarding wizard. Render fullscreen без sidebar/
	// AdminSidebar: prospect ещё не настроил property, и навигация (Шахматка/
	// Гости/Дебиторка) уводит на пустые dashboards. Onboarding focus canon
	// 2026-05-22. Segment-aware match — см. `is-fullscreen-wizard-route.ts`
	// (purely pathname-based — does not depend on TanStack Router runtime).
	const isFullscreenWizard = isFullscreenWizardRoute(location.pathname)

	useEffect(
		() =>
			subscribeAuthBroadcasts({
				onLogout: () => {
					void queryClient.invalidateQueries({ queryKey: sessionQueryOptions.queryKey })
					// BUG-BH8 (A.bis.5 senior self-audit 2026-05-12): без
					// `reloadDocument: true` peer-tab navigation hits /login
					// beforeLoad which calls `ensureQueryData(sessionQueryOptions)`
					// — that returns CACHED valid session (invalidation выше
					// async ещё не отыграло) → /login bounces back to
					// `search.redirect ?? '/'`. Tab A's `useSignOut` уже
					// использует reloadDocument:true; peer tab MUST mirror.
					void router.navigate({
						to: '/login',
						search: { redirect: undefined },
						reloadDocument: true,
					})
				},
				onOrgChange: (_organizationId, slug) => {
					void queryClient.invalidateQueries({ queryKey: sessionQueryOptions.queryKey })
					// Same race vector: org-change peer-tab navigation needs the
					// router context rehydrated с new active org session shape.
					// `_app/o/$orgSlug` guard reads cached session; without
					// reloadDocument peer tab may stick on old slug.
					void router.navigate({
						to: '/o/$orgSlug',
						params: { orgSlug: slug },
						reloadDocument: true,
					})
				},
			}),
		[queryClient, router],
	)

	if (isFullscreenWizard) {
		return (
			<>
				<Outlet />
				<InstallPrompt />
			</>
		)
	}

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
						<span className="text-sm font-semibold tracking-tight">Сэпшн</span>
					</header>
				) : null}
				<Outlet />
				{/* PWA install hint (mobile only, dismissable, persists). */}
				<InstallPrompt />
			</SidebarInset>
		</SidebarProvider>
	)
}
