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
 * Architectural rationale: каждый отель имеет свою копию demo OTA в
 * своём кабинете (user strategic vision 2026-05-28). Webhook secret +
 * channelConnection rows seeded автоматически at org creation via
 * `auth.ts.afterCreateOrganization` hook + `lib/demo-channel-seed.ts`.
 *
 * Canon: `feedback_round_14_6_per_tenant_demo_canon_2026_05_28.md`.
 */
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { ShowcasePage } from '../_demo/side-by-side/showcase-page.tsx'

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
	return (
		<ShowcasePage initialChannel={search.channel ?? 'yandex'} pmsGridUrl={`/o/${orgSlug}/grid`} />
	)
}
