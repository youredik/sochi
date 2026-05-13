import { SmartCaptcha } from '@yandex/smart-captcha'

interface CaptchaFieldProps {
	/** Called with the short-lived token when the user solves the challenge. */
	onToken: (token: string) => void
	/** Bump this value to force remount and reset the widget (e.g. after a failed submit). */
	resetKey?: number
}

/**
 * Yandex SmartCaptcha widget wrapper.
 *
 * Renders nothing when `VITE_YANDEX_CAPTCHA_SITE_KEY` is unset — lets dev mode
 * skip captcha without per-form branches. In preprod/prod the key is baked in
 * by the CI pipeline; the backend `before` hook in `auth.ts` refuses requests
 * without a valid token (anti-enumeration first, per
 * `lib/auth/captcha-gate.ts`).
 *
 * Lineage: stankoff-v2 `apps/frontend/src/features/auth/components/captcha-field.tsx`,
 * adapted to read `import.meta.env` directly (sochi has no central env.ts).
 */
export function CaptchaField({ onToken, resetKey = 0 }: CaptchaFieldProps) {
	const siteKey = import.meta.env.VITE_YANDEX_CAPTCHA_SITE_KEY
	if (!siteKey) return null

	return (
		<div className="flex justify-center">
			<SmartCaptcha
				key={resetKey}
				sitekey={siteKey}
				language="ru"
				onSuccess={onToken}
				onTokenExpired={() => onToken('')}
				onNetworkError={() => onToken('')}
			/>
		</div>
	)
}
