import { useQuery } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { api } from '../lib/api.ts'

/**
 * Tenant dashboard — `/o/{slug}/`.
 *
 * beforeLoad empties-state check: if the tenant has zero properties,
 * bounce to `/o/{slug}/setup` (M5c wizard). Without this, the dashboard
 * has nothing to render and the user is stuck. The check runs once per
 * navigation — TQ caches the property list for subsequent visits.
 */
export const Route = createFileRoute('/_app/o/$orgSlug/')({
	beforeLoad: async ({ context, params }) => {
		const list = await context.queryClient.ensureQueryData({
			queryKey: ['properties'] as const,
			queryFn: async () => {
				const res = await api.api.v1.properties.$get({ query: {} })
				if (!res.ok) throw new Error(`properties.list HTTP ${res.status}`)
				const body = (await res.json()) as { data: Array<{ id: string }> }
				return body.data
			},
			staleTime: 30_000,
		})
		if (list.length === 0) {
			throw redirect({ to: '/o/$orgSlug/setup', params: { orgSlug: params.orgSlug } })
		}
	},
	component: TenantHome,
})

function TenantHome() {
	const { organization } = Route.useRouteContext()
	const health = useQuery({
		queryKey: ['health', 'db'],
		queryFn: async () => {
			const res = await api.health.db.$get()
			return res.json()
		},
		refetchInterval: 15_000,
	})

	return (
		<main className="mx-auto max-w-5xl px-6 py-10">
			<h1 className="text-2xl font-semibold tracking-tight">{organization.name}</h1>
			<p className="text-muted-foreground mt-1 text-sm">
				<span className="font-mono">/o/{organization.slug}</span>
			</p>

			<section className="mt-10 grid gap-4 sm:grid-cols-2">
				<div className="border-border bg-card rounded-lg border p-6">
					<h2 className="text-muted-foreground text-sm font-medium">Шахматка</h2>
					<p className="text-muted-foreground mt-2 text-sm">Появится в следующей фазе (M5d).</p>
				</div>
				<div className="border-border bg-card rounded-lg border p-6">
					<h2 className="text-muted-foreground text-sm font-medium">Объекты размещения</h2>
					<p className="text-muted-foreground mt-2 text-sm">
						Гостиница создана. Следующая фаза (M5d) добавит шахматку бронирований.
					</p>
				</div>
			</section>

			<footer className="border-border text-muted-foreground mt-12 border-t pt-4 text-xs">
				Статус бэкенда:{' '}
				<span className={health.data?.status === 'ok' ? 'text-emerald-600' : 'text-amber-600'}>
					{health.data?.status ?? '…'}
				</span>{' '}
				· YDB:{' '}
				<span className={health.data?.ydb.connected ? 'text-emerald-600' : 'text-destructive'}>
					{health.data?.ydb.connected ? 'connected' : 'disconnected'}
				</span>
			</footer>
		</main>
	)
}
