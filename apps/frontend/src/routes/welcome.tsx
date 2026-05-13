import { createFileRoute, redirect } from '@tanstack/react-router'
import { WelcomeForm } from '../features/auth/components/welcome-form.tsx'
import { sessionQueryOptions } from '../lib/auth-client.ts'

/**
 * Post-magic-link signup completion route.
 *
 * Flow (passwordless canon 2026-05-13 per `[[auth-passwordless-canon]]`):
 *   1. User submits MagicLinkSignUpForm на /signup with email + orgName.
 *   2. BA dispatches magic-link with `callbackURL=/welcome?n=<orgName>`.
 *   3. User clicks email link → BA verify creates user JIT + sets cookie →
 *      302 to /welcome?n=…
 *   4. This route: confirms session exists (else bounce to /login), reads
 *      orgName from query, lets user confirm/edit, creates organization,
 *      navigates to /o/$slug/setup для 2-screen onboarding wizard.
 *
 * Existing-org guard: if the authenticated user already has an active
 * organization, redirect к /. Prevents accidental re-creates when someone
 * lands on /welcome via stale magic-link bookmark.
 *
 * UI lives in `WelcomeForm` component (testable separately); this file
 * owns routing-level concerns only (validateSearch + beforeLoad guard).
 */
export const Route = createFileRoute('/welcome')({
	validateSearch: (search: Record<string, unknown>) => ({
		n: typeof search.n === 'string' ? search.n : undefined,
	}),
	beforeLoad: async ({ context }) => {
		const session = await context.queryClient.ensureQueryData(sessionQueryOptions)
		if (!session?.session) {
			throw redirect({ to: '/login', search: { redirect: undefined } })
		}
		if (session.session.activeOrganizationId) {
			throw redirect({ to: '/' })
		}
	},
	component: WelcomePage,
})

function WelcomePage() {
	const { n: queryOrgName } = Route.useSearch()
	return (
		<main className="mx-auto max-w-sm px-6 py-16">
			<h1 className="text-2xl font-semibold tracking-tight">Почти готово</h1>
			<p className="mt-1 text-muted-foreground text-sm">
				Email подтверждён. Создадим вашу гостиницу — это последний шаг до Шахматки.
			</p>
			<WelcomeForm prefillOrgName={queryOrgName} />
		</main>
	)
}
