/**
 * Round 14.6 — per-tenant demo OTA в кабинете отеля.
 *
 * Mount path: `/o/{orgSlug}/demo` — auth-gated через `_app` parent route
 * (Better Auth session required + orgSlug ↔ activeOrganizationId synced).
 *
 * Inside, отельер видит ту же ShowcasePage side-by-side layout что и
 * `demo.sepshn.ru/showcase`, но ОТА façade теперь хранит брони/токены
 * в их собственном tenant scope (Round 14.6 store refactor). PMS grid
 * iframe указан на `/o/{orgSlug}/grid` — на их собственную шахматку.
 *
 * **UX guardrail (Round 14.6 Phase E.bis):** users без real property
 * see a banner directing them к `/setup` wizard. Closes UX trap caught
 * post-Phase-C self-review — magic-link wow redirect lands здесь без
 * properties, sidebar items needing propertyId render hidden/disabled,
 * user could get stuck not knowing how to onboard. Banner deferred к
 * `OnboardingHintBanner` standalone component (Phase F.bis) for test
 * isolation — its test does not need to mock the route runtime.
 *
 * Architectural rationale: каждый отель имеет свою копию demo OTA в
 * своём кабинете (user strategic vision 2026-05-28). Webhook secret +
 * channelConnection rows seeded автоматически at org creation via
 * `auth.ts.afterCreateOrganization` hook + `lib/demo-channel-seed.ts`.
 *
 * Canon: `feedback_round_14_6_per_tenant_demo_canon_2026_05_28.md`.
 */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { OnboardingHintBanner } from '../_demo/onboarding/onboarding-hint-banner.tsx'
import { ShowcasePage } from '../_demo/side-by-side/showcase-page.tsx'
import { propertiesQueryOptions } from '../features/receivables/hooks/use-receivables.ts'

const searchSchema = z.object({
	channel: z.enum(['yandex', 'ostrovok']).optional(),
})

export const Route = createFileRoute('/_app/o/$orgSlug/demo')({
	component: TenantDemoRoute,
	validateSearch: searchSchema,
})

function TenantDemoRoute() {
	const { orgSlug } = Route.useParams()
	const search = Route.useSearch()
	const properties = useQuery(propertiesQueryOptions)
	const [bannerDismissed, setBannerDismissed] = useState(false)

	// Show the onboarding hint только когда query has resolved AND user has
	// zero properties AND hasn't dismissed. Loading state suppresses the
	// banner (no flash) — properties query короткое (TQ 30s staleTime).
	const showOnboardingHint =
		!bannerDismissed && properties.data !== undefined && properties.data.length === 0

	return (
		<div className="flex h-screen flex-col">
			<OnboardingHintBanner
				visible={showOnboardingHint}
				orgSlug={orgSlug}
				onDismiss={() => setBannerDismissed(true)}
			/>
			<div className="min-h-0 flex-1">
				<ShowcasePage
					initialChannel={search.channel ?? 'yandex'}
					pmsGridUrl={`/o/${orgSlug}/grid`}
				/>
			</div>
		</div>
	)
}
