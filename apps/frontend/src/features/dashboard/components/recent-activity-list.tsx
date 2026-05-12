/**
 * RecentActivityList — reverse-chronological tenant-wide audit feed.
 *
 * Backed by `GET /api/v1/activity/recent?limit=N` (A.bis.3 backend addition).
 * Each row: "Создано бронирование" (verb+noun via `dashboard-labels.ts`) +
 * relative timestamp via `formatRelative`.
 *
 * Empty-state copy is celebratory per R1 research (Pencil & Paper 2026 +
 * NN/G guidance): "Активности пока нет — здесь появятся события по
 * бронированиям и платежам". NOT sterile "No data".
 *
 * Three-state UI (Loading | Error | Value+empty subtree):
 *   - Loading: 3 Skeleton row placeholders (shape-preserving)
 *   - Error: role=alert with RU canonical "Не удалось загрузить"
 *   - Value empty: friendly RU copy explaining what will appear here
 *   - Value with rows: `<ul>` of activity descriptors
 *
 * a11y:
 *   - section aria-labelledby="recent-activity-heading"
 *   - heading: h2 «Недавние события»
 *   - each list item carries the activity descriptor + a `<time dateTime>` for
 *     screen-reader navigation
 */
import { useQuery } from '@tanstack/react-query'
import { useId } from 'react'
import { Skeleton } from '../../../components/ui/skeleton.tsx'
import { formatRelative } from '../../../lib/format-ru.ts'
import { describeActivity } from '../lib/dashboard-labels.ts'
import { recentActivityQueryOptions } from '../lib/use-dashboard-data.ts'

const ERROR_LOAD_RU = 'Не удалось загрузить'
const EMPTY_RU =
	'Активности пока нет — здесь появятся события по бронированиям, платежам и уведомлениям.'

export function RecentActivityList() {
	const activity = useQuery(recentActivityQueryOptions(20))
	const headingId = useId()

	return (
		<section
			aria-labelledby={headingId}
			data-dashboard-section="recent-activity"
			className="bg-card text-card-foreground ring-foreground/10 rounded-xl p-4 ring-1"
		>
			<h2 id={headingId} className="text-base font-medium leading-snug">
				Недавние события
			</h2>
			<p className="text-muted-foreground mt-1 text-xs">
				События последних бронирований, платежей и уведомлений.
			</p>
			{activity.isPending ? (
				<div role="status" aria-busy="true" aria-live="polite" className="mt-4 space-y-3">
					<span className="sr-only">Загрузка</span>
					<Skeleton className="h-5 w-full" />
					<Skeleton className="h-5 w-4/5" />
					<Skeleton className="h-5 w-3/5" />
				</div>
			) : activity.isError ? (
				<p role="alert" aria-live="assertive" className="text-destructive mt-4 text-sm font-medium">
					{ERROR_LOAD_RU}
				</p>
			) : activity.data && activity.data.length > 0 ? (
				<ul className="mt-3 space-y-2" data-testid="recent-activity-items">
					{activity.data.map((row) => (
						<li
							key={row.id}
							className="border-border/40 flex items-start justify-between gap-3 border-b py-2 last:border-b-0"
						>
							<span className="text-sm">
								{describeActivity({
									objectType: row.objectType,
									activityType: row.activityType,
								})}
							</span>
							<time
								dateTime={row.createdAt}
								className="text-muted-foreground shrink-0 text-xs tabular-nums"
							>
								{formatRelative(row.createdAt)}
							</time>
						</li>
					))}
				</ul>
			) : (
				<p className="text-muted-foreground mt-4 text-sm" data-testid="recent-activity-empty">
					{EMPTY_RU}
				</p>
			)}
		</section>
	)
}
