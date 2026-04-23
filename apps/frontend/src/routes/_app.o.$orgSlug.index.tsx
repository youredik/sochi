import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { api } from '../lib/api.ts'

/**
 * Tenant dashboard — `/o/{slug}/`. Bare skeleton for M5a.2; subsequent
 * M5 phases replace the "coming soon" blocks with:
 *   - setup wizard cards (M5c) when empty-state
 *   - reservation chessboard (M5d) once properties exist
 *   - KPI summary (boль 3.1 из MVP мандата)
 *
 * Keeps the existing health/db probe visible so the dev loop retains
 * the "backend is alive" signal we had on the pre-auth home screen.
 */
export const Route = createFileRoute('/_app/o/$orgSlug/')({
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
			<p className="mt-1 text-sm text-neutral-400">
				<span className="font-mono">/o/{organization.slug}</span>
			</p>

			<section className="mt-10 grid gap-4 sm:grid-cols-2">
				<div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-6">
					<h2 className="text-sm font-medium text-neutral-400">Шахматка</h2>
					<p className="mt-2 text-sm text-neutral-500">Появится в следующей фазе (M5d).</p>
				</div>
				<div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-6">
					<h2 className="text-sm font-medium text-neutral-400">Объекты размещения</h2>
					<p className="mt-2 text-sm text-neutral-500">
						Мастер настройки — M5c (свойство → тип номера → номера).
					</p>
				</div>
			</section>

			<footer className="mt-12 border-t border-neutral-900 pt-4 text-xs text-neutral-600">
				Статус бэкенда:{' '}
				<span className={health.data?.status === 'ok' ? 'text-emerald-500' : 'text-amber-500'}>
					{health.data?.status ?? '…'}
				</span>{' '}
				· YDB:{' '}
				<span className={health.data?.ydb.connected ? 'text-emerald-500' : 'text-red-500'}>
					{health.data?.ydb.connected ? 'connected' : 'disconnected'}
				</span>
			</footer>
		</main>
	)
}
