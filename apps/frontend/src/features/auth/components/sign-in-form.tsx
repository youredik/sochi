import { Link } from '@tanstack/react-router'
import { type FormEvent, useId, useState } from 'react'
import { useSignInEmail } from '../hooks/use-auth-mutations.ts'
import type { LocalizedError } from '../lib/errors.ts'

/**
 * Sign-in form. Plain `useState` + HTML5 validation (no TanStack Form / RHF
 * — 2026 consensus for 2-field auth flow; see stankoff-v2 + Wisp 2026).
 *
 * Accessibility beyond stankoff-v2 baseline:
 *   - `htmlFor`/`id` via `useId()` for label-input association
 *   - `aria-describedby` links each input to its inline error hint
 *   - `aria-invalid` flips to "true" only after server rejection
 *   - `aria-live="polite"` on the top-level error banner so screen readers
 *     announce failures without hijacking focus mid-type
 *   - `autoComplete` tags prime password managers
 *   - `type="email"` + `required` + `minLength=8` cover HTML5 validation
 *     (server is the authoritative gate anyway)
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
					className="rounded-md border border-red-800/60 bg-red-950/40 px-3 py-2 text-sm text-red-200"
				>
					<p className="font-medium">{error.title}</p>
					{error.description ? <p className="mt-1 text-red-300/80">{error.description}</p> : null}
				</div>
			) : null}

			<div>
				<label htmlFor={emailId} className="block text-sm font-medium text-neutral-200">
					Email
				</label>
				<input
					id={emailId}
					type="email"
					autoComplete="email"
					required
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					aria-invalid={signIn.isError ? true : undefined}
					aria-describedby={signIn.isError ? errorId : undefined}
					className="mt-1.5 block w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
					placeholder="you@example.com"
				/>
			</div>

			<div>
				<label htmlFor={passwordId} className="block text-sm font-medium text-neutral-200">
					Пароль
				</label>
				<input
					id={passwordId}
					type="password"
					autoComplete="current-password"
					required
					minLength={8}
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					aria-invalid={signIn.isError ? true : undefined}
					aria-describedby={signIn.isError ? errorId : undefined}
					className="mt-1.5 block w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
				/>
			</div>

			<button
				type="submit"
				disabled={signIn.isPending || error?.blocking === true}
				className="inline-flex w-full items-center justify-center rounded-md bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-900 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
			>
				{signIn.isPending ? 'Входим…' : 'Войти'}
			</button>

			<p className="text-center text-sm text-neutral-400">
				Нет аккаунта?{' '}
				<Link to="/signup" className="text-blue-400 hover:text-blue-300">
					Зарегистрироваться
				</Link>
			</p>
		</form>
	)
}
