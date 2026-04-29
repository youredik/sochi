/**
 * Public booking widget route — `/widget/{tenantSlug}`.
 *
 * NO auth gate, NO `_app` prefix. Anonymous user lands here через embed
 * snippet OR direct link.
 *
 * Per `plans/m9_widget_canonical.md` §M9.widget.1 + TanStack Router 1.168
 * canonical not-found pattern:
 *   1. Component throws `notFound()` когда API returns null (404)
 *   2. Route's `notFoundComponent` renders custom UI с slug в message
 *   3. Router sets proper 404 status для SEO + crawlers
 *
 * Component handles loading + success states. notFoundComponent handles 404.
 * Clean separation per router canon.
 */

import { createFileRoute, notFound } from '@tanstack/react-router'
import { WidgetPage } from '../features/public-widget/components/widget-page.tsx'

export const Route = createFileRoute('/widget/$tenantSlug')({
	component: WidgetRoutePage,
	notFoundComponent: WidgetNotFound,
})

function WidgetRoutePage() {
	const { tenantSlug } = Route.useParams()
	return (
		<WidgetPage
			tenantSlug={tenantSlug}
			onNotFound={() => {
				throw notFound()
			}}
		/>
	)
}

/**
 * Custom not-found component для widget route. Rendered TanStack Router'ом
 * когда `notFound()` thrown из component lifecycle (e.g. queryFn returns null
 * для unknown tenant slug). Sets HTTP 404 status server-side при SSR
 * (carry-forward к M9.widget.6 embed когда SSR enabled).
 */
function WidgetNotFound() {
	const { tenantSlug } = Route.useParams()
	return (
		<main className="mx-auto max-w-3xl p-4 sm:p-6 md:p-8" lang="ru">
			<h1 className="text-2xl font-semibold">Не найдено</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				Бронирование для адреса <code>{tenantSlug}</code> недоступно. Проверьте ссылку.
			</p>
		</main>
	)
}
