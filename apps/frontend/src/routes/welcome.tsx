import { createFileRoute, redirect } from '@tanstack/react-router'
import { WelcomeForm } from '../features/auth/components/welcome-form.tsx'
import { orgListQueryOptions } from '../features/tenancy/hooks/use-active-org.ts'
import { authClient, sessionQueryOptions } from '../lib/auth-client.ts'
import { resolveWelcomeRedirect } from '../lib/welcome-redirect.ts'

/**
 * Post-magic-link signup completion route — the org-creation surface under
 * the passwordless canon (`[[auth-passwordless-canon]]` 2026-05-13). Magic-
 * link verify ALWAYS lands users session-without-org briefly because the
 * organization is created here, after auth establishes the session.
 *
 * Three flows converge on this route:
 *   1. /signup happy path — MagicLinkSignUpForm dispatches magic-link with
 *      `callbackURL=/welcome?n=<orgName>` so the field renders prefilled
 *      and the user just confirms before submitting org.create.
 *   2. /login JIT path — never-before-seen email + `disableSignUp:false`
 *      mints a user during verify, lands on `/` with no org, and `_app.tsx`
 *      routes here without an orgName param so the form starts empty.
 *   3. **RETURN-VISIT path** (2026-05-21 bug fix per demo-funnel-smoke [E2]):
 *      existing user, expired cookie, re-signup via /signup → /welcome?n=...
 *      callback. Without explicit org-list check, user would see /welcome
 *      form and create a DUPLICATE empty org. Guard now mirrors `_app.tsx`
 *      canonical org-resolution.
 *
 * Routing decision logic extracted в `lib/welcome-redirect.ts` (pure
 * function + 10 strict tests). Route binding (этот файл) handles I/O
 * orchestration + side effects (setActive call).
 *
 * UI lives в `WelcomeForm` component.
 */
export const Route = createFileRoute('/welcome')({
	validateSearch: (search: Record<string, unknown>) => ({
		n: typeof search.n === 'string' ? search.n : undefined,
	}),
	beforeLoad: async ({ context }) => {
		const session = await context.queryClient.ensureQueryData(sessionQueryOptions)
		// Skip orgs fetch если no session (decision не зависит от orgs в этом
		// случае) — экономит 1 HTTP roundtrip для unauth path.
		const orgs = session?.session
			? await context.queryClient.ensureQueryData(orgListQueryOptions).catch(() => null)
			: null

		const decision = resolveWelcomeRedirect({ session, orgs })

		switch (decision.kind) {
			case 'redirect-login':
				throw redirect({ to: '/login', search: { redirect: undefined } })
			case 'redirect-home':
				throw redirect({ to: '/' })
			case 'set-active-and-redirect':
				// Side effect: switch BA session к existing org. Mirror'ит _app.tsx
				// canonical pattern.
				await authClient.organization.setActive({ organizationId: decision.orgId })
				await context.queryClient.invalidateQueries({
					queryKey: sessionQueryOptions.queryKey,
				})
				throw redirect({
					to: '/o/$orgSlug',
					params: { orgSlug: decision.orgSlug },
					reloadDocument: true,
				})
			case 'render-form':
				return
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
