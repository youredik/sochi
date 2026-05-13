import { type FormEvent, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSignInMagicLink } from '../hooks/use-auth-mutations.ts'
import { captchaEnforced } from '../lib/captcha.ts'
import type { LocalizedError } from '../lib/errors.ts'
import { CaptchaField } from './captcha-field.tsx'

interface MagicLinkFormProps {
	/**
	 * Where Better Auth's verify endpoint redirects the user after consuming
	 * the magic link. MUST be a path relative to the frontend root — this
	 * component prepends `window.location.origin` to produce an absolute URL
	 * because BA otherwise prepends `BETTER_AUTH_URL` (backend :8787) and the
	 * verify hop lands in the backend route table → 404.
	 *
	 * Default `/` lets the `_app/` route guard route the user to their
	 * tenant home (`/o/$orgSlug`) or to `/o-select` if they belong to
	 * multiple orgs — same place email+password signin lands.
	 */
	callbackPath?: string
}

/**
 * Passwordless magic-link sign-in.
 *
 * Flow:
 *   1. User types email → POST `/api/auth/sign-in/magic-link`
 *   2. Backend `before` hook (captcha-gate.ts) checks token; then BA's
 *      magic-link plugin signs a single-use 5-minute token and emails the
 *      verify URL through `MailpitAdapter` (dev) or `PostboxAdapter` (prod).
 *   3. User clicks email link (GET `/api/auth/magic-link/verify?token=…`)
 *      → BA sets session cookie → 302 to absolute callback URL.
 *   4. Frontend router guard at `_app/` routes the new session to the
 *      tenant home; new users get an org auto-created by the
 *      `afterCreateOrganization` hook.
 *
 * Sochi inherits the BA plugin from stankoff-v2 lineage but reads
 * `mapAuthError` (not stankoff's `localizeAuthError`) and renders inline
 * error banners that match the SignInForm pattern (sochi has no
 * `<AuthErrorAlert>` primitive).
 */
export function MagicLinkForm({ callbackPath = '/' }: MagicLinkFormProps) {
	const emailId = useId()
	const errorId = useId()
	const [email, setEmail] = useState('')
	const [captchaToken, setCaptchaToken] = useState('')
	const [captchaResetKey, setCaptchaResetKey] = useState(0)
	const [sent, setSent] = useState(false)
	const sendMagicLink = useSignInMagicLink()
	const error: LocalizedError | undefined = sendMagicLink.error ?? undefined

	const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault()
		const absCallback = `${window.location.origin}${callbackPath}`
		sendMagicLink.mutate(
			{ email, callbackURL: absCallback, captchaToken },
			{
				onSuccess: () => {
					setSent(true)
				},
				onError: () => {
					setCaptchaToken('')
					setCaptchaResetKey((k) => k + 1)
				},
			},
		)
	}

	if (sent) {
		return (
			<div
				role="status"
				aria-live="polite"
				className="rounded-md border border-primary/40 bg-primary/5 px-4 py-3 text-sm"
			>
				<p className="font-medium">Письмо отправлено</p>
				<p className="mt-1 text-muted-foreground">
					Мы отправили ссылку для входа на <strong>{email}</strong>. Откройте письмо и нажмите на
					кнопку входа. Ссылка действительна 5 минут.
				</p>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="mt-3"
					onClick={() => {
						setSent(false)
						setEmail('')
						setCaptchaToken('')
						setCaptchaResetKey((k) => k + 1)
					}}
				>
					Отправить на другой email
				</Button>
			</div>
		)
	}

	return (
		<form
			onSubmit={handleSubmit}
			className="space-y-4"
			noValidate
			aria-label="Форма входа по ссылке"
		>
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
					aria-invalid={sendMagicLink.isError ? true : undefined}
					aria-describedby={sendMagicLink.isError ? errorId : undefined}
					placeholder="you@example.com"
				/>
				<p className="text-xs text-muted-foreground">Пришлём ссылку для входа без пароля</p>
			</div>

			{captchaEnforced ? (
				<CaptchaField resetKey={captchaResetKey} onToken={setCaptchaToken} />
			) : null}

			<Button
				type="submit"
				size="lg"
				className="w-full"
				disabled={
					sendMagicLink.isPending ||
					error?.blocking === true ||
					!email ||
					(captchaEnforced && !captchaToken)
				}
			>
				{sendMagicLink.isPending ? 'Отправляем…' : 'Получить ссылку для входа'}
			</Button>
		</form>
	)
}
