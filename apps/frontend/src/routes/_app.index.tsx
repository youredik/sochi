import { createFileRoute, redirect } from '@tanstack/react-router'
import { authClient, sessionQueryOptions } from '../lib/auth-client.ts'

/**
 * / — post-authentication entry. The parent `_app` guard has already
 * asserted session + `activeOrganizationId`, so we know there's an org
 * to land on. Resolve its slug via `organization.list()` (cached), then
 * redirect to the tenant-aware home `/o/{slug}/`.
 *
 * This route NEVER renders a component; it only serves as a redirect
 * hop. Keeps the URL after login predictable and shareable.
 */
export const Route = createFileRoute('/_app/')({
	beforeLoad: async ({ context }) => {
		const session = await context.queryClient.ensureQueryData(sessionQueryOptions)
		const activeId = session?.session?.activeOrganizationId
		if (!activeId) throw redirect({ to: '/o-select' })
		const res = await authClient.organization.list()
		const org = (res.data ?? []).find((o) => o.id === activeId)
		if (!org) throw redirect({ to: '/o-select' })
		throw redirect({ to: '/o/$orgSlug', params: { orgSlug: org.slug } })
	},
})
