import { logger } from '../../logger.ts'

/**
 * Yandex SmartCaptcha server-side validation.
 *
 * Flow: frontend widget (`@yandex/smart-captcha`) produces a short-lived
 * single-use token → passed in auth request body → backend validates via
 * Yandex API before Better Auth processes sign-up / sign-in / magic-link.
 *
 * Docs: https://yandex.cloud/en/docs/smartcaptcha/concepts/validation
 *
 * Canon-fit: SmartCaptcha is a globally-scoped service (not per-tenant), so
 * it does not live behind the `lib/adapters/` registry. Activation is
 * env-gated — `SMARTCAPTCHA_SERVER_KEY` unset → bypass (dev/CI); set →
 * enforce (preprod / prod). Per `feedback_yandex_cloud_only.md` we stay on
 * Yandex Cloud captcha rather than Cloudflare Turnstile, both for data
 * localization and 152-ФЗ posture.
 */

const VALIDATE_URL = 'https://smartcaptcha.yandexcloud.net/validate'
// 3s — validate API is typically <200ms; 3s ceiling covers network jitter
// without becoming a slow-loris vector on our auth endpoints.
const VALIDATE_TIMEOUT_MS = 3_000

interface YandexValidateResponse {
	status: 'ok' | 'failed'
	message?: string
	host?: string
}

export interface CaptchaValidationResult {
	ok: boolean
	/** Short, non-sensitive reason suitable for structured logs. */
	reason?: 'invalid_token' | 'network_error' | 'timeout' | 'bad_response'
}

/**
 * Validate a SmartCaptcha token against Yandex API.
 *
 * **Fail-closed on network / timeout / bad-response**: when the Yandex API
 * is unreachable we reject the auth request (ok=false). This trades
 * availability for security — an attacker cannot bypass captcha by
 * DoS-ing the validate endpoint from our side. Yandex's own docs suggest
 * fail-open for general UX, but auth endpoints warrant the stricter
 * posture.
 *
 * Token logging is truncated to the first 8 chars (tokens are single-use
 * but still sensitive until expired).
 */
export async function validateCaptcha(
	serverKey: string,
	token: string,
	clientIp?: string,
): Promise<CaptchaValidationResult> {
	const tokenPrefix = token.slice(0, 8)

	const body = new URLSearchParams({
		secret: serverKey,
		token,
	})
	if (clientIp) body.set('ip', clientIp)

	let res: Response
	try {
		res = await fetch(VALIDATE_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body,
			signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
		})
	} catch (err) {
		const isTimeout = err instanceof Error && err.name === 'TimeoutError'
		logger.warn(
			{ tokenPrefix, clientIp, err: err instanceof Error ? err.message : String(err) },
			isTimeout
				? 'Captcha validate timed out — failing closed'
				: 'Captcha validate network error — failing closed',
		)
		return { ok: false, reason: isTimeout ? 'timeout' : 'network_error' }
	}

	if (!res.ok) {
		logger.warn(
			{ tokenPrefix, clientIp, status: res.status },
			'Captcha validate non-2xx — failing closed',
		)
		return { ok: false, reason: 'bad_response' }
	}

	let data: YandexValidateResponse
	try {
		data = (await res.json()) as YandexValidateResponse
	} catch (err) {
		logger.warn(
			{ tokenPrefix, clientIp, err: err instanceof Error ? err.message : String(err) },
			'Captcha validate returned non-JSON body — failing closed',
		)
		return { ok: false, reason: 'bad_response' }
	}

	if (data.status === 'ok') {
		logger.debug({ tokenPrefix, host: data.host }, 'Captcha validated')
		return { ok: true }
	}

	logger.warn(
		{ tokenPrefix, clientIp, message: data.message, host: data.host },
		'Captcha validation failed',
	)
	return { ok: false, reason: 'invalid_token' }
}
