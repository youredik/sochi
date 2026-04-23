import { Link } from '@tanstack/react-router'
import { type FormEvent, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
 * shadcn primitives (Button/Input/Label/Checkbox). Slug preview is a live
 * readonly hint so the user sees their future `/o/{slug}/` URL before
 * submitting — reduces support tickets about "where did my hotel go".
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
					className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
				>
					<p className="font-medium">{error.title}</p>
					{error.description ? <p className="mt-1 opacity-80">{error.description}</p> : null}
				</div>
			) : null}

			<div className="space-y-1.5">
				<Label htmlFor={nameId}>Ваше имя</Label>
				<Input
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
				/>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor={emailId}>Email</Label>
				<Input
					id={emailId}
					type="email"
					autoComplete="email"
					required
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					aria-invalid={signUp.isError ? true : undefined}
					aria-describedby={signUp.isError ? errorId : undefined}
					placeholder="you@example.com"
				/>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor={passwordId}>Пароль</Label>
				<Input
					id={passwordId}
					type="password"
					autoComplete="new-password"
					required
					minLength={8}
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					aria-invalid={signUp.isError ? true : undefined}
					aria-describedby={signUp.isError ? errorId : undefined}
				/>
				<p className="text-xs text-muted-foreground">Минимум 8 символов.</p>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor={orgNameId}>Название гостиницы</Label>
				<Input
					id={orgNameId}
					type="text"
					autoComplete="organization"
					required
					minLength={2}
					maxLength={80}
					value={orgName}
					onChange={(e) => setOrgName(e.target.value)}
					aria-describedby={slugId}
					placeholder="Гостиница Ромашка"
				/>
				<p id={slugId} className="text-xs text-muted-foreground">
					Адрес кабинета: <span className="font-mono">/o/{slugPreview || '…'}</span>
				</p>
			</div>

			<div className="flex items-start gap-2">
				<Checkbox
					id={consentId}
					checked={consent}
					onCheckedChange={(v) => setConsent(v === true)}
					required
					className="mt-0.5"
				/>
				<Label htmlFor={consentId} className="text-sm font-normal leading-snug">
					Даю согласие на обработку персональных данных в соответствии с{' '}
					<Link to="/privacy" className="text-primary underline-offset-4 hover:underline">
						политикой конфиденциальности
					</Link>
					.
				</Label>
			</div>

			<Button
				type="submit"
				size="lg"
				className="w-full"
				disabled={signUp.isPending || error?.blocking === true}
			>
				{signUp.isPending ? 'Создаём…' : 'Создать аккаунт'}
			</Button>

			<p className="text-center text-sm text-muted-foreground">
				Уже есть аккаунт?{' '}
				<Link
					to="/login"
					search={{ redirect: undefined }}
					className="text-primary underline-offset-4 hover:underline"
				>
					Войти
				</Link>
			</p>
		</form>
	)
}
