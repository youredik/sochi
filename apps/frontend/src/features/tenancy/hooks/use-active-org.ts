import { useQuery } from '@tanstack/react-query'
import { authClient, sessionQueryOptions } from '../../../lib/auth-client.ts'

/**
 * Active organization for the current session.
 *
 * Source of truth is BA `session.activeOrganizationId` — set automatically
 * by our backend `databaseHooks.session.create.before` for solo-org users
 * on login, and manually via `authClient.organization.setActive({...})`
 * when the URL `/o/{orgSlug}/` resolves to a different org than the
 * session currently carries.
 *
 * The tenant-aware route layer (`_app.o.$orgSlug.tsx`) is the single place
 * that calls `setActive`. Components below the route guard can assume the
 * session's active org matches the URL slug.
 */

export function useOrgList() {
	return useQuery({
		queryKey: ['auth', 'organizations'] as const,
		queryFn: async () => {
			const res = await authClient.organization.list()
			if (res.error) throw new Error(res.error.message ?? 'Не удалось получить список организаций')
			return res.data ?? []
		},
		staleTime: 60_000,
	})
}

export function useActiveOrg() {
	const session = useQuery(sessionQueryOptions)
	const orgs = useOrgList()
	const activeId = session.data?.session?.activeOrganizationId
	const active = activeId ? (orgs.data?.find((o) => o.id === activeId) ?? null) : null
	return {
		active,
		orgs: orgs.data ?? [],
		isLoading: session.isPending || orgs.isPending,
	}
}
