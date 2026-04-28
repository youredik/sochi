import { Link } from '@tanstack/react-router'
import { type FormEvent, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSignInEmail } from '../hooks/use-auth-mutations.ts'
import type { LocalizedError } from '../lib/errors.ts'
import { PasskeySigninButton } from './passkey-signin-button.tsx'

/**
 * Sign-in form — shadcn primitives (Button/Input/Label) + plain `useState`
 * (5-field form, no TanStack Form required per stankoff-v2 pattern + Wisp
 * 2026 consensus).
 *
 * Accessibility beyond stankoff baseline:
 *   - `htmlFor`/`id` via `useId()` for label-input association
 *   - `aria-describedby` links each input to its inline error region
 *   - `aria-invalid` flips to "true" only after server rejection
 *   - `aria-live="polite"` on error banner announces failures without
 *     hijacking focus mid-type
 *   - `autoComplete` tags prime password managers
 *   - HTML5 `type="email"` + `required` + `minLength` validate on submit
 *     (server is the authoritative gate; HTML5 is UX affordance)
 */
export function SignInForm({ redirect }: { redirect?: string | undefined }) {
	const emailId = useId()
	const passwordId = useId()
	const errorId = useId()
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const signIn = useSignInEmail()
	const error: LocalizedError | undefined = signIn.error ?? undefined

	const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault()
		signIn.mutate({ email, password, redirect })
	}

	return (
		<form onSubmit={handleSubmit} className="space-y-4" noValidate>
			{error ? (
				<div
					id={errorId}
					role="alert"
					aria-live="polite"
					className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
				>
					<p className="font-medium">{error.title}</p>
					{error.description ? <p className="mt-1 opacity-80">{error.description}</p> : null}
				</div>
			) : null}

			<div className="space-y-1.5">
				<Label htmlFor={emailId}>Email</Label>
				<Input
					id={emailId}
					type="email"
					autoComplete="email"
					required
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					aria-invalid={signIn.isError ? true : undefined}
					aria-describedby={signIn.isError ? errorId : undefined}
					placeholder="you@example.com"
				/>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor={passwordId}>Пароль</Label>
				<Input
					id={passwordId}
					type="password"
					autoComplete="current-password"
					required
					minLength={8}
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					aria-invalid={signIn.isError ? true : undefined}
					aria-describedby={signIn.isError ? errorId : undefined}
				/>
			</div>

			<Button
				type="submit"
				size="lg"
				className="w-full"
				disabled={signIn.isPending || error?.blocking === true}
			>
				{signIn.isPending ? 'Входим…' : 'Войти'}
			</Button>

			{/* M9.5 Phase D — passkey signin (parallel auth path). */}
			<div className="flex items-center gap-3 text-xs text-muted-foreground">
				<span className="bg-border h-px flex-1" />
				<span>или</span>
				<span className="bg-border h-px flex-1" />
			</div>
			<PasskeySigninButton />

			<p className="text-center text-sm text-muted-foreground">
				Нет аккаунта?{' '}
				<Link to="/signup" className="text-primary underline underline-offset-4 hover:no-underline">
					Зарегистрироваться
				</Link>
			</p>
		</form>
	)
}
