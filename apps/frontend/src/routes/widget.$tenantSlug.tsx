/**
 * Public booking widget route — `/widget/{tenantSlug}`.
 *
 * NO auth gate, NO `_app` prefix. Anonymous user lands here через embed
 * snippet OR direct link. Thin wrapper над `<WidgetPage>` — actual
 * render logic + state matrix живёт в pure component для testability.
 *
 * Per `plans/m9_widget_canonical.md` §M9.widget.1: minimal route, hostable
 * на book.{tenant}.ru subdomain (production) OR /widget/{slug} (preview).
 */

import { createFileRoute, notFound } from '@tanstack/react-router'
import { WidgetPage } from '../features/public-widget/components/widget-page.tsx'

export const Route = createFileRoute('/widget/$tenantSlug')({
	component: WidgetRoutePage,
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
