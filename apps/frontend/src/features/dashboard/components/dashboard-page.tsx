/**
 * DashboardPage — composition root для tenant operator landing.
 *
 * Layout (per R1 research Cloudbeds / SaaSFrame 2026):
 *   - Top: KPI metric strip (4 cards, RBAC-gated)
 *   - Below: split grid — RecentActivity col-span-2 + Alerts col-span-1
 *     (stacked on mobile, side-by-side from `lg:` per `feedback`
 *     `m9_widget_canonical` md:/lg: domain breakpoint canon)
 *
 * Per `feedback_no_halfway.md`: Alerts hidden completely для staff (lacks
 * `notification:read`) — not rendered, NOT shown-with-empty-data hint.
 * RecentActivity remains universal: every role with any read access sees the
 * tenant audit feed (driven by `/activity/recent`, server-side scoped to
 * tenant).
 *
 * Plan deviation note (POST-AUDIT C38, see plan §17): the page no longer
 * shows nav tiles — that role moved to the sidebar (A.bis.2). The page is
 * now pure operational summary, matching the operator persona (glance
 * between guest interactions) instead of being a redundant nav-хаб.
 */
import { hasPermission, type MemberRole } from '@horeca/shared'
import { AlertsList } from './alerts-list.tsx'
import { KpiStrip } from './kpi-strip.tsx'
import { RecentActivityList } from './recent-activity-list.tsx'

export type DashboardPageProps = {
	readonly organizationName: string
	readonly orgSlug: string
	readonly memberRole: MemberRole | undefined
	readonly propertyId: string | undefined
}

export function DashboardPage({
	organizationName,
	orgSlug,
	memberRole,
	propertyId,
}: DashboardPageProps) {
	const canSeeAlerts =
		memberRole !== undefined && hasPermission(memberRole, { notification: ['read'] })

	return (
		<main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
			<header className="mb-6">
				<h1 className="text-2xl font-semibold tracking-tight">{organizationName}</h1>
				<p className="text-muted-foreground mt-1 text-sm">Сводка по гостинице на сегодня.</p>
			</header>
			{propertyId ? (
				<KpiStrip memberRole={memberRole} propertyId={propertyId} />
			) : (
				<p className="text-muted-foreground text-sm" data-testid="dashboard-no-property">
					Подождите, загружаем данные гостиницы…
				</p>
			)}
			<div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
				<div className={canSeeAlerts ? 'lg:col-span-2' : 'lg:col-span-3'}>
					<RecentActivityList />
				</div>
				{canSeeAlerts ? (
					<div>
						<AlertsList orgSlug={orgSlug} />
					</div>
				) : null}
			</div>
		</main>
	)
}
