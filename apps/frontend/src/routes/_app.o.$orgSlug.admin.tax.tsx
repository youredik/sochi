/**
 * Admin tourism-tax report — `/o/{orgSlug}/admin/tax`.
 *
 * Per memory `project_ru_tax_form_2026q1.md`:
 *   - **KPI cards** (bookings, nights, налоговая база, налог) — top.
 *   - **Monthly breakdown** — line `005` декларации КНД 1153008.
 *   - **Per-booking rows table** (sortable) — drill-down material.
 *   - **Filter bar** — quarter quick-presets + property select + XLSX download.
 *   - Льгота columns intentionally placeholder until M8 МВД flow.
 *   - PDF декларации НЕ делаем — accountants generate через 1С/Контур-Экстерн.
 *
 * **RBAC gate** (per memory `feedback_pre_done_audit.md`):
 *   - `beforeLoad` checks role through `meQueryOptions` — staff redirected
 *     to org dashboard. Backend's `requirePermission({ report: ['read'] })`
 *     is the load-bearing gate; this is UX hint только.
 *
 * **A11y per axe-core 4.11:**
 *   - Single `<main>` + `<h1>` (`aria-labelledby`).
 *   - KPI cards `<dl>` semantic.
 *   - Tables `<caption className="sr-only">` + `<th scope="col">`.
 *   - Status/channel badges: text + non-color signal.
 */
import { hasPermission } from '@horeca/shared'
import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useId } from 'react'
import { z } from 'zod'
import { ErrorState } from '../components/error-state.tsx'
import { Button } from '../components/ui/button.tsx'
import { TaxFilterBar } from '../features/admin-tax/components/tax-filter-bar.tsx'
import { TaxKpiCards } from '../features/admin-tax/components/tax-kpi-cards.tsx'
import { TaxMonthlyTable } from '../features/admin-tax/components/tax-monthly-table.tsx'
import { TaxRowsTable } from '../features/admin-tax/components/tax-rows-table.tsx'
import {
	buildTourismTaxXlsxUrl,
	tourismTaxOrgReportQueryOptions,
} from '../features/admin-tax/hooks/use-tourism-tax-report.ts'
import { defaultPeriod } from '../features/admin-tax/lib/quarter-defaults.ts'
import { propertiesQueryOptions } from '../features/receivables/hooks/use-receivables.ts'
import { meQueryOptions } from '../lib/use-can.ts'

const adminTaxSearchSchema = z
	.object({
		from: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается YYYY-MM-DD')
			.optional(),
		to: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается YYYY-MM-DD')
			.optional(),
		propertyId: z.string().optional(),
	})
	.refine((v) => !v.from || !v.to || v.from <= v.to, {
		message: 'from должен быть <= to',
	})

type AdminTaxSearch = z.infer<typeof adminTaxSearchSchema>

export const Route = createFileRoute('/_app/o/$orgSlug/admin/tax')({
	validateSearch: (input: Record<string, unknown>): AdminTaxSearch =>
		adminTaxSearchSchema.parse(input),
	loaderDeps: ({ search }) => ({
		from: search.from,
		to: search.to,
		propertyId: search.propertyId,
	}),
	beforeLoad: async ({ context: { queryClient }, params }) => {
		// RBAC gate — UX hint, mirrors backend `requirePermission({ report: ['read'] })`.
		const me = await queryClient.ensureQueryData(meQueryOptions)
		if (!hasPermission(me.role, { report: ['read'] })) {
			throw redirect({ to: '/o/$orgSlug', params: { orgSlug: params.orgSlug } })
		}
		// Property pool — for filter dropdown + setup-redirect.
		const properties = await queryClient.ensureQueryData(propertiesQueryOptions)
		if (properties.length === 0) {
			throw redirect({ to: '/o/$orgSlug/setup', params: { orgSlug: params.orgSlug } })
		}
	},
	loader: async ({ context: { queryClient }, deps }) => {
		const period = deps.from && deps.to ? { from: deps.from, to: deps.to } : defaultPeriod()
		await queryClient.ensureQueryData(
			tourismTaxOrgReportQueryOptions({
				from: period.from,
				to: period.to,
				...(deps.propertyId ? { propertyId: deps.propertyId } : {}),
			}),
		)
	},
	pendingComponent: AdminTaxSkeleton,
	errorComponent: AdminTaxErrorPanel,
	pendingMs: 200,
	pendingMinMs: 500,
	component: AdminTaxRoute,
})

function AdminTaxSkeleton() {
	return (
		<main aria-busy="true" aria-live="polite" className="container mx-auto p-6">
			<div className="space-y-6">
				<div className="h-8 w-1/3 animate-pulse rounded bg-muted" />
				<div className="h-12 w-full animate-pulse rounded bg-muted" />
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
					{[0, 1, 2, 3].map((i) => (
						<div key={i} className="h-24 animate-pulse rounded bg-muted" />
					))}
				</div>
				<div className="h-48 animate-pulse rounded bg-muted" />
				<div className="h-96 animate-pulse rounded bg-muted" />
			</div>
		</main>
	)
}

function AdminTaxErrorPanel({ error }: { error: Error }) {
	return (
		<main className="container mx-auto p-6">
			<ErrorState
				title="Не удалось загрузить отчёт по туристическому налогу"
				error={error}
				onRetry={() => {
					window.location.reload()
				}}
			/>
		</main>
	)
}

function AdminTaxRoute() {
	const { orgSlug } = Route.useParams()
	const search = Route.useSearch()
	const navigate = Route.useNavigate()

	const period = search.from && search.to ? { from: search.from, to: search.to } : defaultPeriod()
	const queryParams = {
		from: period.from,
		to: period.to,
		...(search.propertyId ? { propertyId: search.propertyId } : {}),
	}
	const properties = useSuspenseQuery(propertiesQueryOptions).data
	const report = useSuspenseQuery(tourismTaxOrgReportQueryOptions(queryParams)).data

	const headingId = useId()
	const xlsxUrl = buildTourismTaxXlsxUrl(queryParams)

	return (
		<main className="container mx-auto p-6 space-y-6" aria-labelledby={headingId}>
			<header className="space-y-1">
				<h1 id={headingId} className="text-2xl font-semibold tracking-tight">
					Туристический налог
				</h1>
				<p className="text-sm text-muted-foreground">
					Отчёт за период {report.period.from} — {report.period.to}
					{report.propertyId
						? ` · объект ${properties.find((p) => p.id === report.propertyId)?.name ?? report.propertyId}`
						: ' · все объекты организации'}
				</p>
			</header>

			<section aria-label="Фильтры">
				<TaxFilterBar
					value={{
						from: period.from,
						to: period.to,
						propertyId: search.propertyId ?? null,
					}}
					properties={properties}
					xlsxUrl={xlsxUrl}
					onChange={(next) => {
						navigate({
							search: {
								from: next.from,
								to: next.to,
								...(next.propertyId ? { propertyId: next.propertyId } : {}),
							},
							replace: true,
						})
					}}
				/>
			</section>

			<section aria-label="Ключевые показатели">
				<TaxKpiCards kpi={report.kpi} />
			</section>

			<section aria-label="Помесячная разбивка" className="space-y-2">
				<h2 className="text-base font-medium">Помесячно</h2>
				<TaxMonthlyTable monthly={report.monthly} />
			</section>

			<section aria-label="Бронирования" className="space-y-2">
				<h2 className="text-base font-medium">По бронированиям</h2>
				<TaxRowsTable rows={report.rows} />
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
