import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useOrgList } from '../features/tenancy/hooks/use-active-org.ts'
import { authClient, sessionQueryOptions } from '../lib/auth-client.ts'
import { broadcastOrgChange } from '../lib/broadcast-auth.ts'

/**
 * Organization chooser for users with 2+ orgs who land without an active
 * selection. For solo-owner (первый этап) most users never see this screen — the
 * `_app` guard auto-selects when there's exactly one org.
 */
export const Route = createFileRoute('/_app/o-select')({
	component: OrgSelect,
})

function OrgSelect() {
	const { data: orgs = [], isPending } = useOrgList()
	const queryClient = useQueryClient()
	const navigate = useNavigate()

	const choose = async (id: string, slug: string) => {
		const res = await authClient.organization.setActive({ organizationId: id })
		if (res.error) return
		await queryClient.invalidateQueries({ queryKey: sessionQueryOptions.queryKey })
		broadcastOrgChange(id, slug)
		void navigate({ to: '/o/$orgSlug', params: { orgSlug: slug }, reloadDocument: true })
	}

	return (
		<main className="mx-auto max-w-md px-6 py-16">
			<h1 className="text-2xl font-semibold tracking-tight">Выберите гостиницу</h1>
			<p className="mt-1 text-muted-foreground text-sm">
				У вас несколько организаций. Выберите, с какой продолжить работу.
			</p>
			{isPending ? (
				<p className="mt-8 text-sm text-neutral-500">Загружаем…</p>
			) : (
				<ul className="mt-8 space-y-2">
					{orgs.map((o) => (
						<li key={o.id}>
							<button
								type="button"
								onClick={() => choose(o.id, o.slug)}
								className="flex w-full items-center justify-between rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3 text-left text-sm text-neutral-100 hover:border-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
							>
								<span className="font-medium">{o.name}</span>
								<span className="font-mono text-xs text-neutral-500">/o/{o.slug}</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</main>
	)
}
