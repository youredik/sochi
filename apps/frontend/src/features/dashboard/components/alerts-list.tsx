/**
 * AlertsList — operator-actionable failed-notifications panel.
 *
 * Backed by `failedNotificationsQueryOptions` (single query feeds both
 * "Письма со сбоем" KPI count AND this panel — no race).
 *
 * Severity: every failed-notification row gets `destructive` (one severity
 * here; future expansion to warnings would add another tier). Per R1
 * research (SaaSFrame anatomy 2026): severity via **icon + color**, NOT a
 * "level" tag — operator parses faster from visual cue than a label.
 *
 * Empty-state celebratory copy per R1 + Pencil & Paper 2026: "Всё спокойно —
 * нет требующих внимания событий". Implicit CTA (no button), per NN/G empty
 * state guidance: when there's nothing to act on, don't fabricate an action.
 *
 * Click-through: each row links to the admin/notifications drill-down via
 * TanStack Router `<Link>` (preserves SPA navigation + nested-route active
 * highlight) — per plan canon. Container provides `orgSlug` because route
 * carries `/o/:slug/admin/notifications/:id`.
 */
import type { Notification } from '@horeca/shared'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AlertCircleIcon } from 'lucide-react'
import { useId } from 'react'
import { Skeleton } from '../../../components/ui/skeleton.tsx'
import { formatRelative } from '../../../lib/format-ru.ts'
import { failedNotificationsQueryOptions } from '../lib/use-dashboard-data.ts'

const ERROR_LOAD_RU = 'Не удалось загрузить'
const EMPTY_RU = 'Всё спокойно — нет требующих внимания событий.'

export type AlertsListProps = {
	readonly orgSlug: string
}

export function AlertsList({ orgSlug }: AlertsListProps) {
	const failed = useQuery(failedNotificationsQueryOptions)
	const headingId = useId()

	return (
		<section
			aria-labelledby={headingId}
			data-dashboard-section="alerts"
			className="bg-card text-card-foreground ring-foreground/10 rounded-xl p-4 ring-1"
		>
			<h2 id={headingId} className="text-base font-medium leading-snug">
				Требует внимания
			</h2>
			<p className="text-muted-foreground mt-1 text-xs">
				Сбои уведомлений: гость не получил письмо или администрация не получила оповещение.
			</p>
			{failed.isPending ? (
				<div role="status" aria-busy="true" aria-live="polite" className="mt-4 space-y-3">
					<span className="sr-only">Загрузка</span>
					<Skeleton className="h-5 w-full" />
					<Skeleton className="h-5 w-4/5" />
				</div>
			) : failed.isError ? (
				<p role="alert" aria-live="assertive" className="text-destructive mt-4 text-sm font-medium">
					{ERROR_LOAD_RU}
				</p>
			) : failed.data && failed.data.length > 0 ? (
				<ul className="mt-3 space-y-2" data-testid="alerts-items">
					{failed.data.map((row) => (
						<AlertRow key={row.id} row={row} orgSlug={orgSlug} />
					))}
				</ul>
			) : (
				<p className="text-muted-foreground mt-4 text-sm" data-testid="alerts-empty">
					{EMPTY_RU}
				</p>
			)}
		</section>
	)
}

function AlertRow({ row, orgSlug }: { row: Notification; orgSlug: string }) {
	return (
		<li className="border-border/40 border-b py-2 last:border-b-0">
			<Link
				to="/o/$orgSlug/admin/notifications"
				params={{ orgSlug }}
				className="hover:bg-muted/50 -mx-2 flex items-start gap-2 rounded-md px-2 py-1.5"
				aria-label={`Сбой уведомления: ${row.subject}`}
			>
				<AlertCircleIcon aria-hidden="true" className="text-destructive mt-0.5 size-4 shrink-0" />
				<span className="min-w-0 flex-1">
					<span className="block truncate text-sm font-medium">{row.subject}</span>
					<span className="text-muted-foreground block truncate text-xs">
						{row.recipient}
						{row.failedAt ? ` · ${formatRelative(row.failedAt)}` : ''}
					</span>
				</span>
			</Link>
		</li>
	)
}
