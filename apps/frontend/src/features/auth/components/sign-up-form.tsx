import { Link } from '@tanstack/react-router'
import { type FormEvent, useId, useState } from 'react'
import { useSignUp } from '../hooks/use-auth-mutations.ts'
import type { LocalizedError } from '../lib/errors.ts'
import { slugify } from '../lib/slugify.ts'

/**
 * Sign-up form. Collects user + organization in one shot — for a solo
 * hotel owner in Сочи, "create account" and "create the first property
 * container" are inseparable concerns and splitting them into two screens
 * adds friction without compliance upside.
 *
 * Mandatory 152-ФЗ consent checkbox is part of the form (not a footer
 * notice) — without an explicit affirmative action, processing personal
 * data for the subsequent МВД / tourism-tax reporting would be a direct
 * violation. See project_ru_compliance_blockers memory.
 *
 * Accessibility: full labels + aria-invalid/describedby + aria-live error;
 * `slug` is a readonly preview computed live from `orgName` so the user
 * sees the URL their property dashboard will live at before submitting.
 */
export function SignUpForm() {
	const nameId = useId()
	const emailId = useId()
	const passwordId = useId()
	const orgNameId = useId()
	const slugId = useId()
	const consentId = useId()
	const errorId = useId()

	const [name, setName] = useState('')
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [orgName, setOrgName] = useState('')
	const [consent, setConsent] = useState(false)

	const signUp = useSignUp()
	const error: LocalizedError | undefined = signUp.error ?? undefined
	const slugPreview = slugify(orgName)

	const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault()
		signUp.mutate({ name, email, password, orgName, consentPersonalData: consent })
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
				<label htmlFor={nameId} className="block text-sm font-medium text-neutral-200">
					Ваше имя
				</label>
				<input
					id={nameId}
					type="text"
					autoComplete="name"
					required
					minLength={2}
					maxLength={80}
					value={name}
					onChange={(e) => setName(e.target.value)}
					aria-invalid={signUp.isError ? true : undefined}
					aria-describedby={signUp.isError ? errorId : undefined}
					className="mt-1.5 block w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
				/>
			</div>

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
					aria-invalid={signUp.isError ? true : undefined}
					aria-describedby={signUp.isError ? errorId : undefined}
					className="mt-1.5 block w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
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
					autoComplete="new-password"
					required
					minLength={8}
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					aria-invalid={signUp.isError ? true : undefined}
					aria-describedby={signUp.isError ? errorId : undefined}
					className="mt-1.5 block w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
				/>
				<p className="mt-1 text-xs text-neutral-500">Минимум 8 символов.</p>
			</div>

			<div>
				<label htmlFor={orgNameId} className="block text-sm font-medium text-neutral-200">
					Название гостиницы
				</label>
				<input
					id={orgNameId}
					type="text"
					autoComplete="organization"
					required
					minLength={2}
					maxLength={80}
					value={orgName}
					onChange={(e) => setOrgName(e.target.value)}
					aria-describedby={slugId}
					className="mt-1.5 block w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
					placeholder="Гостиница Ромашка"
				/>
				<p id={slugId} className="mt-1 text-xs text-neutral-500">
					Адрес кабинета:{' '}
					<span className="font-mono text-neutral-400">/o/{slugPreview || '…'}</span>
				</p>
			</div>

			<div className="flex items-start gap-2">
				<input
					id={consentId}
					type="checkbox"
					checked={consent}
					onChange={(e) => setConsent(e.target.checked)}
					required
					className="mt-1 h-4 w-4 rounded border-neutral-600 bg-neutral-900 text-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
				/>
				<label htmlFor={consentId} className="text-sm text-neutral-300">
					Даю согласие на обработку персональных данных в соответствии с{' '}
					<Link to="/privacy" className="text-blue-400 hover:text-blue-300">
						политикой конфиденциальности
					</Link>
					.
				</label>
			</div>

			<button
				type="submit"
				disabled={signUp.isPending || error?.blocking === true}
				className="inline-flex w-full items-center justify-center rounded-md bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-900 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
			>
				{signUp.isPending ? 'Создаём…' : 'Создать аккаунт'}
			</button>

			<p className="text-center text-sm text-neutral-400">
				Уже есть аккаунт?{' '}
				<Link
					to="/login"
					search={{ redirect: undefined }}
					className="text-blue-400 hover:text-blue-300"
				>
					Войти
				</Link>
			</p>
		</form>
	)
}
