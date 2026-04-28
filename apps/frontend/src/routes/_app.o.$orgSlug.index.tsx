import { hasPermission } from '@horeca/shared'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { propertiesQueryOptions } from '../features/receivables/hooks/use-receivables.ts'
import { api } from '../lib/api.ts'
import { useCurrentRole } from '../lib/use-can.ts'

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
	const role = useCurrentRole()
	const canReadReports = role !== undefined && hasPermission(role, { report: ['read'] })
	const canReadNotifications = role !== undefined && hasPermission(role, { notification: ['read'] })
	// `compliance:read` covers both owner+manager (152-ФЗ tax-regime guidance);
	// the content wizard's per-step components further gate write operations
	// on the server side. Tile is the operator's only entry point to the
	// wizard — without it the route is reachable only by URL editing.
	const canSeeContent =
		role !== undefined &&
		(hasPermission(role, { compliance: ['read'] }) || hasPermission(role, { amenity: ['read'] }))
	// Read cached properties (route's beforeLoad already prefetched + verified
	// length>=1 redirects to /setup if empty). First property is canonical
	// "Шахматка" target — small operators have 1 hotel; multi-property
	// dashboard with per-property tiles ships when the data justifies it.
	const properties = useQuery(propertiesQueryOptions)
	const firstProperty = properties.data?.[0]
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
				<Link
					to="/o/$orgSlug/grid"
					params={{ orgSlug: organization.slug }}
					className="border-border bg-card hover:border-primary rounded-lg border p-6 transition-colors"
				>
					<h2 className="font-medium">Шахматка</h2>
					<p className="text-muted-foreground mt-2 text-sm">
						Посмотреть 15-дневное окно бронирований по типам номеров.
					</p>
				</Link>
				<Link
					to="/o/$orgSlug/receivables"
					params={{ orgSlug: organization.slug }}
					className="border-border bg-card hover:border-primary rounded-lg border p-6 transition-colors"
				>
					<h2 className="font-medium">Дебиторка</h2>
					<p className="text-muted-foreground mt-2 text-sm">
						Открытые счета с положительным балансом, KPI и aging-разрез.
					</p>
				</Link>
				{canReadReports ? (
					<Link
						to="/o/$orgSlug/admin/tax"
						params={{ orgSlug: organization.slug }}
						className="border-border bg-card hover:border-primary rounded-lg border p-6 transition-colors"
					>
						<h2 className="font-medium">Туристический налог</h2>
						<p className="text-muted-foreground mt-2 text-sm">
							Квартальный отчёт по бронированиям, помесячная разбивка, выгрузка XLSX для бухгалтера.
						</p>
					</Link>
				) : null}
				{canReadNotifications ? (
					<Link
						to="/o/$orgSlug/admin/notifications"
						params={{ orgSlug: organization.slug }}
						className="border-border bg-card hover:border-primary rounded-lg border p-6 transition-colors"
					>
						<h2 className="font-medium">Уведомления</h2>
						<p className="text-muted-foreground mt-2 text-sm">
							История писем гостям и администрации: статусы, фильтры, повтор отправки при сбое.
						</p>
					</Link>
				) : null}
				{canSeeContent && firstProperty ? (
					<Link
						to="/o/$orgSlug/properties/$propertyId/content"
						params={{ orgSlug: organization.slug, propertyId: firstProperty.id }}
						className="border-border bg-card hover:border-primary rounded-lg border p-6 transition-colors"
					>
						<h2 className="font-medium">Профиль гостиницы</h2>
						<p className="text-muted-foreground mt-2 text-sm">
							Compliance (КСР, налоги), удобства, описание, фото, услуги — всё для каналов продаж и
							публичного виджета.
						</p>
					</Link>
				) : null}
			</section>

			<footer className="border-border text-muted-foreground mt-12 border-t pt-4 text-xs">
				Статус бэкенда:{' '}
				<span
					className={
						health.data?.status === 'ok'
							? 'text-emerald-700 dark:text-emerald-400'
							: 'text-amber-700 dark:text-amber-400'
					}
				>
					{health.data?.status ?? '…'}
				</span>{' '}
				· YDB:{' '}
				<span
					className={
						health.data?.ydb.connected
							? 'text-emerald-700 dark:text-emerald-400'
							: 'text-destructive'
					}
				>
					{health.data?.ydb.connected ? 'connected' : 'disconnected'}
				</span>
			</footer>
		</main>
	)
}
