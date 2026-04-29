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

/**
 * RU plural rules — three forms (one / few / many) per CLDR canonical.
 * Used для «N объект/объекта/объектов» badge в widget header.
 *
 * Rules:
 *   - mod100 in 11..14 → many (объектов): «11 объектов», «14 объектов»
 *   - mod10 === 1 → one (объект): «1 объект», «21 объект», «101 объект»
 *   - mod10 in 2..4 → few (объекта): «2 объекта», «23 объекта»
 *   - else → many (объектов): «5 объектов», «10 объектов»
 *
 * Negative numbers / non-integers — caller must guard (zero-config widget).
 */
export function ruPlural(n: number, one: string, few: string, many: string): string {
	const mod10 = n % 10
	const mod100 = n % 100
	if (mod100 >= 11 && mod100 <= 14) return many
	if (mod10 === 1) return one
	if (mod10 >= 2 && mod10 <= 4) return few
	return many
}

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
		<div
			lang="ru"
			className="min-h-svh bg-gradient-to-b from-primary/5 via-background to-background"
		>
			<main className="mx-auto max-w-3xl p-4 sm:p-6 md:p-8">
				<header className="pt-2 pb-6 md:pt-6 md:pb-8">
					<p className="text-xs font-medium uppercase tracking-wider text-primary">
						Прямое бронирование · Сочи
					</p>
					<h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
						{data.tenant.name}
					</h1>
					{data.tenant.mode === 'demo' ? (
						<p
							data-testid="demo-banner"
							className="mt-3 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary"
						>
							<span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
							<span>Демо-режим — это живая витрина продукта</span>
						</p>
					) : null}
				</header>

				<section
					aria-label="Список объектов размещения"
					className="rounded-xl border bg-card p-4 shadow-sm md:p-6"
				>
					<div className="flex items-baseline justify-between">
						<h2 className="text-lg font-medium">Объекты размещения</h2>
						<span
							data-testid="properties-count"
							className="text-xs text-muted-foreground tabular-nums"
						>
							{data.properties.length}{' '}
							{ruPlural(data.properties.length, 'объект', 'объекта', 'объектов')}
						</span>
					</div>

					{data.properties.length === 0 ? (
						<p className="mt-4 text-sm text-muted-foreground">
							Этот отель не опубликовал объекты для онлайн-бронирования. Свяжитесь с ресепшеном.
						</p>
					) : (
						<ul className="mt-4 space-y-3">
							{data.properties.map((p) => (
								<li key={p.id}>
									<button
										type="button"
										aria-label={`Открыть ${p.name}`}
										className="group flex w-full items-start justify-between gap-4 rounded-lg border bg-background p-4 text-left transition hover:border-primary hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
									>
										<div className="min-w-0 flex-1">
											<h3 className="font-medium tracking-tight">{p.name}</h3>
											<p className="mt-1 text-sm text-muted-foreground">{p.address}</p>
											<p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
												<span>{p.timezone}</span>
												{p.tourismTaxRateBps !== null ? (
													<span>
														· Туристический налог{' '}
														<span className="tabular-nums">
															{(p.tourismTaxRateBps / 100).toFixed(1)}%
														</span>
													</span>
												) : null}
											</p>
										</div>
										<svg
											aria-hidden
											role="presentation"
											className="mt-1 h-5 w-5 flex-shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary"
											viewBox="0 0 20 20"
											fill="none"
											stroke="currentColor"
											strokeWidth="1.5"
										>
											<title></title>
											<path d="M7.5 4l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
										</svg>
									</button>
								</li>
							))}
						</ul>
					)}
				</section>

				<section aria-label="Что дальше" className="mt-6 md:mt-8">
					<div className="rounded-xl border border-dashed border-primary/30 bg-primary/5 p-4 md:p-6">
						<h2 className="text-base font-medium">3 простых шага бронирования</h2>
						<ol className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
							<li className="flex items-start gap-2">
								<span
									aria-hidden
									className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground tabular-nums"
								>
									1
								</span>
								<span>Выбираете даты и количество гостей</span>
							</li>
							<li className="flex items-start gap-2">
								<span
									aria-hidden
									className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground tabular-nums"
								>
									2
								</span>
								<span>Подбираете номер и тариф</span>
							</li>
							<li className="flex items-start gap-2">
								<span
									aria-hidden
									className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground tabular-nums"
								>
									3
								</span>
								<span>Оплачиваете онлайн — без комиссии посредников</span>
							</li>
						</ol>
					</div>
				</section>

				<footer className="mt-8 flex flex-col gap-2 border-t pt-4 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
					<span>Прямое бронирование · экономия до 17% против OTA</span>
					<span className="text-[10px] uppercase tracking-wider">Powered by Сочи HoReCa</span>
				</footer>
			</main>
		</div>
	)
}
