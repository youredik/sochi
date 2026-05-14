import { createFileRoute, redirect } from '@tanstack/react-router'
import { MagicLinkSignUpForm } from '../features/auth/components/magic-link-signup-form.tsx'
import { sessionQueryOptions } from '../lib/auth-client.ts'

/**
 * Signup route — public. Mirrors /login inverse guard: authenticated users
 * get bounced home. Signup uses the same magic-link entrypoint as sign-in
 * (BA's `disableSignUp: false` lets JIT-create a user on first verify) plus
 * an organization name field gated by 152-ФЗ consent — both fields flow
 * through the magic-link callback URL into `/welcome` где org creation runs.
 *
 * **Passwordless canon 2026-05-13** per `[[auth-passwordless-canon]]`:
 * SignUpForm (legacy email+password) was deleted entirely. RU HoReCa SMB
 * persona — small hoteliers — don't want to remember another password;
 * magic-link + passkey covers the full journey.
 */
export const Route = createFileRoute('/signup')({
	beforeLoad: async ({ context }) => {
		const session = await context.queryClient.ensureQueryData(sessionQueryOptions)
		if (!session?.session) return
		// Inverse guard. Three session-states arrive here:
		//   • session + activeOrganizationId → user already settled; / → /o/{slug}
		//   • session + no org (post-magic-link, pre-creation per passwordless
		//     canon shift `3b0b486`) → /welcome (the org-creation surface).
		//     Skipping straight к /welcome avoids the `/signup → / → /welcome`
		//     hop that `_app.tsx` would otherwise take.
		//   • session + no org but signin context (JIT via /login) — same
		//     destination /welcome; this route is reached only if the user
		//     manually navigates к /signup which is harmless.
		if (!session.session.activeOrganizationId) {
			throw redirect({ to: '/welcome', search: { n: undefined } })
		}
		throw redirect({ to: '/' })
	},
	component: SignUpPage,
})

function SignUpPage() {
	return (
		<main className="mx-auto max-w-sm px-6 py-16">
			<h1 className="text-2xl font-semibold tracking-tight">Регистрация</h1>
			<p className="mt-1 text-muted-foreground text-sm">
				Откройте кабинет за минуту — без пароля. Пришлём ссылку на email.
			</p>
			<div className="mt-8">
				<MagicLinkSignUpForm />
			</div>
		</main>
	)
}
