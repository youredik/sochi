import { createFileRoute, redirect } from '@tanstack/react-router'
import { WelcomeForm } from '../features/auth/components/welcome-form.tsx'
import { sessionQueryOptions } from '../lib/auth-client.ts'

/**
 * Post-magic-link signup completion route — the org-creation surface under
 * the passwordless canon (`[[auth-passwordless-canon]]` 2026-05-13). Magic-
 * link verify ALWAYS lands users session-without-org briefly because the
 * organization is created here, after auth establishes the session.
 *
 * Two flows converge on this route:
 *   1. /signup happy path — MagicLinkSignUpForm dispatches magic-link with
 *      `callbackURL=/welcome?n=<orgName>` so the field renders prefilled
 *      and the user just confirms before submitting org.create.
 *   2. /login JIT path — never-before-seen email + `disableSignUp:false`
 *      mints a user during verify, lands on `/` with no org, and `_app.tsx`
 *      routes here without an orgName param so the form starts empty.
 *
 * Both paths render the same WelcomeForm; copy «Почти готово. Email
 * подтверждён.» reads correctly for both contexts.
 *
 * Inverse guard: an authenticated user who already has an active org gets
 * redirected к /. Prevents accidental re-creates from stale magic-link
 * bookmarks or browser-back navigation.
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
