import { Link } from '@tanstack/react-router'
import { type FormEvent, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSignInMagicLink } from '../hooks/use-auth-mutations.ts'
import { captchaEnforced } from '../lib/captcha.ts'
import type { LocalizedError } from '../lib/errors.ts'
import { slugify } from '../lib/slugify.ts'
import { CaptchaField } from './captcha-field.tsx'

const MAX_ORG_NAME_LENGTH = 80

/**
 * Magic-link signup — sole sign-up entrypoint after passwordless canon
 * 2026-05-13 per `[[auth-passwordless-canon]]`. Replaces the legacy
 * email+password SignUpForm entirely.
 *
 * Flow:
 *   1. User types email + orgName + checks consent + solves captcha (when
 *      enforced) → submit
 *   2. POST `/api/auth/sign-in/magic-link` with `callbackURL=/welcome?n=…`
 *      (orgName URL-encoded into query so the welcome page picks it up)
 *   3. BA mails the verify link via `MailpitAdapter` (dev) / `PostboxAdapter`
 *      (prod). 5-min single-use token.
 *   4. User clicks verify link → BA creates the user JIT (disableSignUp:false)
 *      → 302 to `/welcome?n=…` with session cookie set
 *   5. `/welcome` reads orgName from query, calls `organization.create`,
 *      navigates to `/o/$slug/setup` for the 2-screen onboarding wizard
 *
 * Why orgName на этой странице (а не on /welcome):
 *   - Reduces friction — one form to fill, не two
 *   - Slug preview gives live feedback to user before email round-trip
 *   - The consent checkbox (152-ФЗ) is a HARD-required action — gating it at
 *     signup-time (NOT post-verify) ensures we don't dispatch the verify email
 *     to anyone who hasn't consented to personal-data processing
 *
 * Visual: orgName field has a slug preview hint так that future `/o/{slug}/`
 * URL is visible before submit (reduces support tickets «где моя гостиница»).
 */
export function MagicLinkSignUpForm() {
	const emailId = useId()
	const orgNameId = useId()
	const slugId = useId()
	const consentId = useId()
	const errorId = useId()

	const [email, setEmail] = useState('')
	const [orgName, setOrgName] = useState('')
	const [consent, setConsent] = useState(false)
	const [captchaToken, setCaptchaToken] = useState('')
	const [captchaResetKey, setCaptchaResetKey] = useState(0)
	const [sent, setSent] = useState(false)

	const sendMagicLink = useSignInMagicLink()
	const error: LocalizedError | undefined = sendMagicLink.error ?? undefined
	const slugPreview = slugify(orgName)

	const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault()
		if (!consent) {
			return // submit-button gating already prevents this path
		}
		const callbackPath = `/welcome?n=${encodeURIComponent(orgName.trim())}`
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
					Мы отправили ссылку для регистрации на <strong>{email}</strong>. Откройте письмо и нажмите
					кнопку — после подтверждения email мы сразу создадим гостиницу <strong>{orgName}</strong>.
					Ссылка действительна 5 минут.
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
			aria-label="Регистрация по magic-link"
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
				<p className="text-xs text-muted-foreground">Пришлём ссылку — пароль не нужен</p>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor={orgNameId}>Название гостиницы</Label>
				<Input
					id={orgNameId}
					type="text"
					autoComplete="organization"
					required
					minLength={2}
					maxLength={MAX_ORG_NAME_LENGTH}
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
					<Link
						to="/privacy"
						className="text-primary underline underline-offset-4 hover:no-underline"
					>
						политикой конфиденциальности
					</Link>
					.
				</Label>
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
					orgName.trim().length < 2 ||
					!consent ||
					(captchaEnforced && !captchaToken)
				}
			>
				{sendMagicLink.isPending ? 'Отправляем…' : 'Получить ссылку для регистрации'}
			</Button>

			<p className="text-center text-sm text-muted-foreground">
				Уже есть аккаунт?{' '}
				<Link
					to="/login"
					search={{ redirect: undefined }}
					className="text-primary underline underline-offset-4 hover:no-underline"
				>
					Войти
				</Link>
			</p>
		</form>
	)
}
