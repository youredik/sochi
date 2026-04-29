/**
 * `<WidgetPage>` — pure component для public booking widget root page.
 *
 * Props-based (no router coupling) — testable in isolation. Route file
 * `routes/widget.$tenantSlug.tsx` wires `Route.useParams()` → tenantSlug
 * prop, this component handles render-state matrix:
 *   - loading: skeleton с aria-live="polite"
 *   - error / null data: not-found message
 *   - success: tenant header + demo banner (conditional) + properties list
 *
 * Per `plans/m9_widget_canonical.md` §M9.widget.1 MVP scope. Actual 4-screen
 * flow (search/extras/guest+pay/confirmation) — M9.widget.2-5 sub-phases.
 */
import { useQuery } from '@tanstack/react-query'
import { listPublicProperties } from '../lib/widget-api.ts'

export interface WidgetPageProps {
	readonly tenantSlug: string
	/**
	 * Optional callback fired when the underlying API returns 404 (null view).
	 * Route wrapper uses это to throw `notFound()` для router-level handling
	 * (отдельная страница / redirect). Tests can pass a spy.
	 */
	readonly onNotFound?: () => void
}

export function WidgetPage({ tenantSlug, onNotFound }: WidgetPageProps) {
	const { data, isLoading, isError } = useQuery({
		queryKey: ['public-widget', 'properties', tenantSlug],
		queryFn: async () => {
			const view = await listPublicProperties(tenantSlug)
			if (view === null) {
				onNotFound?.()
				throw new Error('NOT_FOUND')
			}
			return view
		},
		staleTime: 30_000,
		retry: false,
	})

	if (isLoading) {
		return (
			<main className="mx-auto max-w-3xl p-4 sm:p-6 md:p-8" lang="ru">
				<div role="status" aria-live="polite" className="h-8 w-3/5 animate-pulse rounded bg-muted">
					<span className="sr-only">Загрузка…</span>
				</div>
			</main>
		)
	}

	if (isError || !data) {
		return (
			<main className="mx-auto max-w-3xl p-4 sm:p-6 md:p-8" lang="ru">
				<h1 className="text-2xl font-semibold">Не найдено</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					Бронирование для адреса <code>{tenantSlug}</code> недоступно. Проверьте ссылку.
				</p>
			</main>
		)
	}

	return (
		<main className="mx-auto max-w-3xl p-4 sm:p-6 md:p-8" lang="ru">
			<header className="border-b pb-4">
				<h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{data.tenant.name}</h1>
				{data.tenant.mode === 'demo' ? (
					<p
						data-testid="demo-banner"
						className="mt-2 inline-flex items-center gap-2 rounded-md bg-amber-50 px-3 py-1 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-100"
					>
						<span aria-hidden>●</span>
						<span>Демо-режим: данные не сохраняются. Это витрина продукта.</span>
					</p>
				) : null}
			</header>

			<section aria-label="Список объектов размещения" className="mt-6">
				<h2 className="text-lg font-medium">Объекты размещения</h2>
				{data.properties.length === 0 ? (
					<p className="mt-2 text-sm text-muted-foreground">
						Этот отель не опубликовал объекты для онлайн-бронирования. Свяжитесь с ресепшеном.
					</p>
				) : (
					<ul className="mt-3 space-y-3">
						{data.properties.map((p) => (
							<li key={p.id} className="rounded-md border p-4 transition hover:border-primary">
								<h3 className="font-medium">{p.name}</h3>
								<p className="mt-1 text-sm text-muted-foreground">{p.address}</p>
								<p className="mt-1 text-xs text-muted-foreground">
									Часовой пояс: {p.timezone}
									{p.tourismTaxRateBps !== null
										? ` · Туристический налог ${(p.tourismTaxRateBps / 100).toFixed(1)}%`
										: ''}
								</p>
							</li>
						))}
					</ul>
				)}
			</section>

			<footer className="mt-10 border-t pt-4 text-xs text-muted-foreground">
				Скоро здесь — 3-экранный flow бронирования (поиск дат → выбор тарифа → оплата).
			</footer>
		</main>
	)
}
