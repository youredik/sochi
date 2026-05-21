import { createFileRoute, redirect } from '@tanstack/react-router'
import { LandingPage } from '../features/landing/landing-page.tsx'
import { orgListQueryOptions } from '../features/tenancy/hooks/use-active-org.ts'
import { sessionQueryOptions } from '../lib/auth-client.ts'
import { resolveLandingRedirect } from '../lib/landing-redirect.ts'

/**
 * `/` — public landing route. Replaces the prior `_app.index.tsx`
 * redirect-helper. Logic split:
 *
 *   - **Этот файл** = route binding + I/O orchestration (fetch session/orgs,
 *     issue redirect throw).
 *   - **`lib/landing-redirect.ts`** = pure decision function (testable seam
 *     per `feedback_critical_fix_test_coverage_canon`).
 *
 * Fail-open semantics: landing — static credibility page; не должна падать
 * от backend 5xx. Both fetches `.catch(() => null)` — pure function
 * расценивает `null` как «render landing». См. `lib/landing-redirect.ts`
 * docstring для полного set of ветвей.
 *
 * Анонимы skip orgs-fetch — экономит 1 HTTP roundtrip (orgs query был
 * бы 401 anyway).
 */
export const Route = createFileRoute('/')({
	beforeLoad: async ({ context }) => {
		const session = await context.queryClient.ensureQueryData(sessionQueryOptions).catch(() => null)
		// Skip orgs fetch для анонимов — pure function ниже всё равно
		// вернёт null (no session → no redirect).
		const orgs = session?.session?.activeOrganizationId
			? await context.queryClient.ensureQueryData(orgListQueryOptions).catch(() => null)
			: null
		const target = resolveLandingRedirect({ session, orgs })
		if (target) {
			throw redirect(target)
		}
	},
	component: LandingPage,
})
