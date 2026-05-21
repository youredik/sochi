import { createFileRoute, redirect } from '@tanstack/react-router'
import { LandingPage } from '../features/landing/landing-page.tsx'
import { orgListQueryOptions } from '../features/tenancy/hooks/use-active-org.ts'
import { sessionQueryOptions } from '../lib/auth-client.ts'

/**
 * / — public landing route. Replaces the prior `_app.index.tsx`
 * redirect-helper. Auth-aware beforeLoad:
 *   • no session → render LandingPage component (public)
 *   • session + active org → redirect к /o/{slug} (preserves существующее
 *     поведение `to: '/'` redirects из signup.tsx / welcome.tsx /
 *     _app.o.$orgSlug.tsx — залогиненные пользователи продолжают попадать
 *     домой, не на landing)
 *   • session + no active org → /o-select (там _app.tsx подхватит и
 *     обработает edge-cases: zero orgs → /welcome, single org → setActive)
 *
 * Компонент `LandingPage` живёт в `features/landing/` (testable seam).
 */
export const Route = createFileRoute('/')({
	beforeLoad: async ({ context }) => {
		// Public landing — fail-open semantics. Landing — static credibility
		// page; не должна падать от 502/500 backend. Auth-aware redirect ниже
		// — best-effort optimization для залогиненных, не critical path.
		// Если backend down или session-fetch throws — рендерим landing.
		const session = await context.queryClient.ensureQueryData(sessionQueryOptions).catch(() => null)
		if (!session?.session) return
		const activeId = session.session.activeOrganizationId
		if (!activeId) {
			throw redirect({ to: '/o-select' })
		}
		const orgs = await context.queryClient.ensureQueryData(orgListQueryOptions).catch(() => null)
		if (!orgs) return
		const org = orgs.find((o) => o.id === activeId)
		if (!org) {
			throw redirect({ to: '/o-select' })
		}
		throw redirect({ to: '/o/$orgSlug', params: { orgSlug: org.slug } })
	},
	component: LandingPage,
})
