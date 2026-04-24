import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { authClient, sessionQueryOptions } from '../../../lib/auth-client.ts'
import { broadcastOrgChange } from '../../../lib/broadcast-auth.ts'
import { logger } from '../../../lib/logger.ts'
import { useActiveOrg } from '../hooks/use-active-org.ts'

/**
 * Top-bar org switcher.
 *
 * Auto-collapses when the user has a single organization (Mews/Apaleo
 * 2026 pattern for solo-owner admins) — shown as a read-only label.
 * With 2+ orgs, renders a `<select>` that on change calls
 * `organization.setActive`, invalidates the session query, broadcasts
 * to peer tabs, and navigates to the new tenant-aware URL.
 *
 * Kept deliberately minimal: no popover, no search, no avatars. Upgrade
 * to cmdk-backed Command when a user with ~5+ orgs materializes — today
 * our target HoReCa SMB owns 1 property ≈ 1 org.
 */
export function OrgSwitcher() {
	const queryClient = useQueryClient()
	const navigate = useNavigate()
	const { active, orgs, isLoading } = useActiveOrg()

	if (isLoading || active === null) return null

	if (orgs.length <= 1) {
		return <span className="text-sm font-medium text-foreground">{active.name}</span>
	}

	const handleChange = async (event: React.ChangeEvent<HTMLSelectElement>) => {
		const nextId = event.target.value
		const next = orgs.find((o) => o.id === nextId)
		if (!next || next.id === active.id) return
		const res = await authClient.organization.setActive({ organizationId: next.id })
		if (res.error) {
			logger.warn('setActive failed', { code: res.error.code, message: res.error.message })
			return
		}
		await queryClient.invalidateQueries({ queryKey: sessionQueryOptions.queryKey })
		broadcastOrgChange(next.id, next.slug)
		void navigate({ to: '/o/$orgSlug', params: { orgSlug: next.slug }, reloadDocument: true })
	}

	return (
		<label className="flex items-center gap-2 text-sm text-foreground">
			<span className="sr-only">Организация</span>
			<select
				value={active.id}
				onChange={handleChange}
				className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
			>
				{orgs.map((o) => (
					<option key={o.id} value={o.id}>
						{o.name}
					</option>
				))}
			</select>
		</label>
	)
}
