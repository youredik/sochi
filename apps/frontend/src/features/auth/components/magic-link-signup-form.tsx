import { Link } from '@tanstack/react-router'
import { type FormEvent, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSignInMagicLink } from '../hooks/use-auth-mutations.ts'
import { captchaEnforced } from '../lib/captcha.ts'
import { isDemoDeployment } from '../lib/demo-deployment.ts'
import type { LocalizedError } from '../lib/errors.ts'
import { CaptchaField } from './captcha-field.tsx'
import { DemoInboxPanel } from './demo-inbox-panel.tsx'

/**
 * Magic-link signup — sole sign-up entrypoint after passwordless canon
 * 2026-05-13 per `[[auth-passwordless-canon]]`. Replaces the legacy
 * email+password SignUpForm entirely.
 *
 * Round 14.6.2 refactor (2026-05-28) — discovery-first onboarding flow:
 *
 *   Old (halfmeasure): asked email + orgName + 152-ФЗ consent + captcha.
 *   orgName URL-param'd to /welcome → form-prefilled → user retypes →
 *   inside setup IdentifyStep, ИНН lookup overwrites everything via
 *   DaData party rename (canon 2026-05-22 «DaData party wins»). Three
 *   times orgName entered, three times thrown away.
 *
 *   New: signup asks ONLY email + consent + captcha. Welcome route
 *   auto-creates org с placeholder `DEFAULT_WELCOME_ORG_NAME` («Моя
 *   гостиница») + slug `org-<base36>`, redirects к dashboard → /setup
 *   IdentifyStep → ИНН → DaData → real legal name → InventoryStep →
 *   wow landing on per-tenant /demo. One source of truth для name
 *   (DaData party lookup).
 *
 * Flow:
 *   1. User types email + checks consent + solves captcha → submit
 *   2. POST `/api/auth/sign-in/magic-link` с `callbackURL=/welcome`
 *   3. BA mails verify link via `MailpitAdapter` (dev) / `PostboxAdapter`
 *      (prod). 5-min single-use token.
 *   4. User clicks verify link → BA creates user JIT
 *      (disableSignUp:false) → 302 к `/welcome` с session cookie set
 *   5. `/welcome` beforeLoad auto-creates org с placeholder + redirects
 *      к `/o/{slug}/` → dashboard sees 0 properties → redirects к
 *      `/o/{slug}/setup` IdentifyStep
 *
 * Why ONLY email here (and не on /welcome):
 *   - Lowest possible friction — single textbox + checkbox
 *   - 152-ФЗ consent gates the verify-email dispatch (NO email sent
 *     until user consents к personal-data processing)
 *   - Hotel name asked LATER via ИНН lookup (DaData fills it from FNS
 *     registry — no manual typing needed)
 */
export function MagicLinkSignUpForm() {
	const emailId = useId()
	const consentId = useId()
	const errorId = useId()

	const [email, setEmail] = useState('')
	const [consent, setConsent] = useState(false)
	const [captchaToken, setCaptchaToken] = useState('')
	const [captchaResetKey, setCaptchaResetKey] = useState(0)
	const [sent, setSent] = useState(false)

	const sendMagicLink = useSignInMagicLink()
	const error: LocalizedError | undefined = sendMagicLink.error ?? undefined

	const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault()
		if (!consent) {
			return // submit-button gating already prevents this path
		}
		const callbackPath = '/welcome'
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
			<div className="space-y-3">
				<div
					role="status"
					aria-live="polite"
					className="rounded-md border border-primary/40 bg-primary/5 px-4 py-3 text-sm"
				>
					<p className="font-medium">Письмо отправлено</p>
					<p className="mt-1 text-muted-foreground">
						Мы отправили ссылку на <strong>{email}</strong>. Откройте письмо и нажмите кнопку —
						после подтверждения email мы автоматически создадим вашу гостиницу и попросим ИНН для
						заполнения реквизитов. Ссылка действительна 5 минут.
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
				{isDemoDeployment ? <DemoInboxPanel email={email} /> : null}
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
