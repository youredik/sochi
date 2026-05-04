/**
 * Admin channels — `/o/{orgSlug}/admin/channels`.
 *
 * Per `plans/m10_canonical.md` §4 п.28 + Track A DoD #7:
 *   "Channel Manager Mock показывает фейковую sync с TL/YT/ETG visible
 *    на admin overlay"
 *
 * RBAC gate: `report:read` (owner + manager only). Backend's
 * `requirePermission` is the load-bearing gate; this is UX hint.
 *
 * A11y: single `<main>` + `<h1>` + status badges с text + non-color signal
 * + `role="status"` on sync state for SR live-region semantics.
 */

import { hasPermission } from '@horeca/shared'
import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useId } from 'react'
import { ErrorState } from '../components/error-state.tsx'
import { Button } from '../components/ui/button.tsx'
import { ChannelStatusOverlay } from '../features/admin-channels/components/channel-status-overlay.tsx'
import { adminChannelsQueryOptions } from '../features/admin-channels/hooks/use-channels.ts'
import { meQueryOptions } from '../lib/use-can.ts'

export const Route = createFileRoute('/_app/o/$orgSlug/admin/channels')({
	beforeLoad: async ({ context: { queryClient }, params }) => {
		const me = await queryClient.ensureQueryData(meQueryOptions)
		if (!hasPermission(me.role, { report: ['read'] })) {
			throw redirect({ to: '/o/$orgSlug', params: { orgSlug: params.orgSlug } })
		}
	},
	loader: async ({ context: { queryClient } }) => {
		await queryClient.ensureQueryData(adminChannelsQueryOptions())
	},
	pendingComponent: AdminChannelsSkeleton,
	errorComponent: AdminChannelsErrorPanel,
	pendingMs: 200,
	pendingMinMs: 500,
	component: AdminChannelsRoute,
})

function AdminChannelsSkeleton() {
	return (
		<main aria-busy="true" aria-live="polite" className="container mx-auto p-6">
			<div className="space-y-6">
				<div className="h-8 w-1/3 animate-pulse rounded bg-muted" />
				<div className="h-48 animate-pulse rounded bg-muted" />
			</div>
		</main>
	)
}

function AdminChannelsErrorPanel({ error }: { error: Error }) {
	return (
		<main className="container mx-auto p-6">
			<ErrorState
				title="Не удалось загрузить статус каналов"
				error={error}
				onRetry={() => {
					window.location.reload()
				}}
			/>
		</main>
	)
}

function AdminChannelsRoute() {
	const { orgSlug } = Route.useParams()
	const connections = useSuspenseQuery(adminChannelsQueryOptions()).data
	const headingId = useId()

	return (
		<main className="container mx-auto space-y-6 p-6" aria-labelledby={headingId}>
			<header className="space-y-1">
				<h1 id={headingId} className="font-semibold text-2xl tracking-tight">
					Каналы дистрибуции
				</h1>
				<p className="text-muted-foreground text-sm">
					{connections.length === 0
						? 'Каналы пока не подключены — добавьте первый из карточек ниже.'
						: `${connections.length} ${pluralRu(connections.length, 'канал', 'канала', 'каналов')} подключено. Live-flip к санбоксу/проду = смена режима в admin (M11+).`}
				</p>
			</header>

			<section aria-label="Статус каналов">
				<ChannelStatusOverlay connections={connections} />
			</section>

			<nav aria-label="Навигация">
				<Button asChild variant="ghost" size="sm">
					<Link to="/o/$orgSlug" params={{ orgSlug }}>
						← Дашборд
					</Link>
				</Button>
			</nav>
		</main>
	)
}

function pluralRu(n: number, one: string, few: string, many: string): string {
	const mod10 = n % 10
	const mod100 = n % 100
	if (mod10 === 1 && mod100 !== 11) return one
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
	return many
}
