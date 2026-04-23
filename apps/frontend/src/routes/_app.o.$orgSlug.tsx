import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { authClient, sessionQueryOptions } from '../lib/auth-client.ts'

/**
 * Tenant-aware guard: validates that the URL `orgSlug` maps to an org the
 * current user belongs to, AND that it matches the session's
 * `activeOrganizationId`. If the URL slug differs from the active org
 * (common after copy-paste between tabs), we call `setActive` and
 * re-invalidate the session query before rendering child routes.
 *
 * Cross-tenant adversarial: user has sessions for orgs A and B; navigates
 * URL `/o/{B.slug}/...` while session.activeOrganizationId === A.
 * Behaviour here: setActive(B) — so URL is the source of truth, session
 * follows. If B is not in user's org list at all → 404 (redirect to /).
 *
 * This is the single place `setActive` is called from URL change —
 * keeps the invariant "URL slug ↔ active org" defendable.
 */
export const Route = createFileRoute('/_app/o/$orgSlug')({
	beforeLoad: async ({ context, params }) => {
		const res = await authClient.organization.list()
		const orgs = res.data ?? []
		const target = orgs.find((o) => o.slug === params.orgSlug)
		if (!target) {
			throw redirect({ to: '/' })
		}
		const session = await context.queryClient.ensureQueryData(sessionQueryOptions)
		if (session?.session?.activeOrganizationId !== target.id) {
			await authClient.organization.setActive({ organizationId: target.id })
			await context.queryClient.invalidateQueries({ queryKey: sessionQueryOptions.queryKey })
		}
		return { organization: target }
	},
	component: () => <Outlet />,
})
