/**
 * Receivables dashboard — `/o/{orgSlug}/receivables`.
 *
 * Per memory `project_m6_7_frontend_research.md`:
 *   - **4 KPI cards** + **aging breakdown** + **sortable DataTable**.
 *   - **Single-property V1**: V1 demo берёт `properties[0].id`.
 *     Multi-property selector — phase 2.
 *
 * **Route plumbing:**
 *   - `beforeLoad`: prefetches properties; redirect to /setup если 0.
 *   - `loader`: prefetches receivables for first property.
 *   - `pendingComponent` + `errorComponent`.
 *   - `useSuspenseQuery` для тела (suspense boundary handles loading).
 *
 * **A11y per axe-core 4.11:**
 *   - Single `<main>` + single `<h1>` (через aria-labelledby).
 *   - KPI cards + aging slice — `<dl>` semantic.
 *   - Table — `<caption className="sr-only">` + `<th scope="col">`.
 *   - Bucket badge: text + non-color signal (RU label).
 *
 * Sub-компоненты (KpiCards/AgingBreakdownCard/ReceivablesTable) вынесены
 * в `features/receivables/components/` per Fast Refresh канон (M6.7.6).
 */
import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useId } from 'react'
import { ErrorState } from '../components/error-state.tsx'
import { Button } from '../components/ui/button.tsx'
import { AgingBreakdownCard, KpiCards } from '../features/receivables/components/kpi-cards.tsx'
import { ReceivablesTable } from '../features/receivables/components/receivables-table.tsx'
import {
	propertiesQueryOptions,
	receivablesQueryOptions,
} from '../features/receivables/hooks/use-receivables.ts'
import { summarizeReceivables } from '../features/receivables/lib/aging-buckets.ts'

export const Route = createFileRoute('/_app/o/$orgSlug/receivables')({
	beforeLoad: async ({ context: { queryClient }, params }) => {
		const list = await queryClient.ensureQueryData(propertiesQueryOptions)
		if (list.length === 0) {
			throw redirect({ to: '/o/$orgSlug/setup', params: { orgSlug: params.orgSlug } })
		}
	},
	loader: async ({ context: { queryClient } }) => {
		const properties = await queryClient.ensureQueryData(propertiesQueryOptions)
		const first = properties[0]
		if (!first) return
		await queryClient.ensureQueryData(receivablesQueryOptions(first.id))
	},
	pendingComponent: ReceivablesSkeleton,
	errorComponent: ReceivablesErrorPanel,
	pendingMs: 200,
	pendingMinMs: 500,
	component: ReceivablesRoute,
})

function ReceivablesSkeleton() {
	return (
		<main aria-busy="true" aria-live="polite" className="container mx-auto p-6">
			<div className="space-y-6">
				<div className="h-8 w-1/3 animate-pulse rounded bg-muted" />
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
					{[0, 1, 2, 3].map((i) => (
						<div key={i} className="h-24 animate-pulse rounded bg-muted" />
					))}
				</div>
				<div className="h-96 animate-pulse rounded bg-muted" />
			</div>
		</main>
	)
}

function ReceivablesErrorPanel({ error }: { error: Error }) {
	return (
		<main className="container mx-auto p-6">
			<ErrorState
				title="Не удалось загрузить дебиторку"
				error={error}
				onRetry={() => {
					window.location.reload()
				}}
			/>
		</main>
	)
}

function ReceivablesRoute() {
	const { orgSlug } = Route.useParams()
	const properties = useSuspenseQuery(propertiesQueryOptions).data
	const property = properties[0]
	if (!property) {
		// beforeLoad guard — defensive, нужен только для TS narrowing
		throw new Error('No property found')
	}
	const folios = useSuspenseQuery(receivablesQueryOptions(property.id)).data

	// `now` фиксируется при каждом render — стабильный snapshot KPI на frame.
	// React Compiler 1.0 GA понимает это как pure derivation.
	const now = new Date()
	const summary = summarizeReceivables(folios, now)

	const headingId = useId()

	return (
		<main className="container mx-auto p-6 space-y-6" aria-labelledby={headingId}>
			<header className="space-y-1">
				<h1 id={headingId} className="text-2xl font-semibold tracking-tight">
					Дебиторская задолженность
				</h1>
				<p className="text-sm text-muted-foreground">
					{property.name} ·{' '}
					{folios.length === 0
						? 'нет открытых счетов'
						: `${folios.length} счетов с положительным балансом`}
				</p>
			</header>

			<section aria-label="Ключевые показатели">
				<KpiCards summary={summary} />
			</section>

			<section aria-label="Распределение по возрасту">
				<AgingBreakdownCard summary={summary} />
			</section>

			<section aria-label="Список счетов">
				<ReceivablesTable folios={folios} now={now} orgSlug={orgSlug} />
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
