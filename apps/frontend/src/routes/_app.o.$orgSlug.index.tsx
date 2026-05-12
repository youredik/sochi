import { useQuery } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { DashboardPage } from '../features/dashboard/components/dashboard-page.tsx'
import { propertiesQueryOptions } from '../features/receivables/hooks/use-receivables.ts'
import { api } from '../lib/api.ts'
import { useCurrentRole } from '../lib/use-can.ts'

/**
 * Tenant dashboard — `/o/{slug}/`.
 *
 * **A.bis.3 (2026-05-12):** tiles → KPI cards composition. Sidebar (A.bis.2)
 * owns navigation; this page is now pure operational summary — Заезды
 * сегодня / В отеле / Открытый баланс / Письма со сбоем + Недавние события +
 * Требует внимания. POST-AUDIT C38: plan v1 wrote Occupancy/ADR/RevPAR
 * placeholders, replaced per `project_dashboard_external.md` canon (3.1
 * KPI = Yandex DataLens external, NOT our code) + R1 research 2026-05-12
 * (Cloudbeds operator dashboard = tactical-today, NOT analytical).
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
	// Route's beforeLoad already prefetched + verified `length>=1` (redirects
	// to /setup if empty). The first property feeds property-scoped KPI
	// queries (bookings window, receivables sum) — same first-property pattern
	// as the prior tile dashboard. Multi-property dashboard per `feedback_no_halfway.md`
	// is its own sub-phase; SMB target persona (5-50 rooms) overwhelmingly
	// runs single property per tenant.
	const properties = useQuery(propertiesQueryOptions)
	const firstProperty = properties.data?.[0]

	return (
		<DashboardPage
			organizationName={organization.name}
			orgSlug={organization.slug}
			memberRole={role}
			propertyId={firstProperty?.id}
		/>
	)
}
