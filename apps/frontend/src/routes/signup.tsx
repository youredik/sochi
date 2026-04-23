import { createFileRoute, redirect } from '@tanstack/react-router'
import { SignUpForm } from '../features/auth/components/sign-up-form.tsx'
import { sessionQueryOptions } from '../lib/auth-client.ts'

/**
 * Signup route — public. Mirrors /login inverse guard: authenticated users
 * get bounced home. Signup flow creates an organization in the same
 * mutation (see features/auth/hooks/use-auth-mutations.ts) so landing
 * here while already logged in would just confuse state.
 */
export const Route = createFileRoute('/signup')({
	beforeLoad: async ({ context }) => {
		const session = await context.queryClient.ensureQueryData(sessionQueryOptions)
		if (session?.session) {
			throw redirect({ to: '/' })
		}
	},
	component: SignUpPage,
})

function SignUpPage() {
	return (
		<main className="mx-auto max-w-sm px-6 py-16">
			<h1 className="text-2xl font-semibold tracking-tight">Регистрация</h1>
			<p className="mt-1 text-muted-foreground text-sm">
				Создайте аккаунт и вашу первую гостиницу на платформе.
			</p>
			<div className="mt-8">
				<SignUpForm />
			</div>
		</main>
	)
}
