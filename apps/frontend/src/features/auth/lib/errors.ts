/**
 * Localized error taxonomy for auth flows (stankoff-v2 pattern verified
 * against 2026 research as scale-ready).
 *
 * Shape:
 *   - `title` — primary message shown next to / below the form
 *   - `description` — optional detail
 *   - `blocking` — when true, disable submit until user acts outside the
 *     form (e.g. reset password, contact admin)
 *   - `actionResend` — flag for rendering a "resend verification" button
 *   - `retryAfterSeconds` — honoring HTTP 429 `Retry-After` hints
 *
 * Use via `mapAuthError(betterAuthError)` — centralised so every form reads
 * the same copy and error-code-handling stays consistent when we add
 * 2FA/passkey/OTP flows in phase 2+.
 */

export interface LocalizedError {
	title: string
	description?: string
	blocking?: boolean
	actionResend?: boolean
	retryAfterSeconds?: number
}

/**
 * Better Auth surfaces errors as `{ message, status, code? }`. We map known
 * codes to Russian-localised user-facing copy; unknown codes fall through to
 * a generic "something went wrong" record with the raw message for support.
 */
export function mapAuthError(error: {
	message?: string | undefined
	status?: number | undefined
	code?: string | undefined
}): LocalizedError {
	const code = error.code?.toUpperCase()

	// Common BA 1.6 error codes
	switch (code) {
		case 'INVALID_EMAIL_OR_PASSWORD':
			return {
				title: 'Неверный email или пароль',
				description: 'Проверьте введённые данные и попробуйте ещё раз.',
			}
		case 'USER_ALREADY_EXISTS':
			return {
				title: 'Пользователь с таким email уже зарегистрирован',
				description: 'Войдите по своим учётным данным или восстановите пароль.',
			}
		case 'EMAIL_NOT_VERIFIED':
			return {
				title: 'Email не подтверждён',
				description: 'Перейдите по ссылке в письме или запросите новое.',
				actionResend: true,
			}
		case 'PASSWORD_TOO_SHORT':
			return {
				title: 'Пароль слишком короткий',
				description: 'Минимум 8 символов.',
			}
		case 'TOO_MANY_REQUESTS':
			return {
				title: 'Слишком много попыток',
				description: 'Подождите немного и попробуйте снова.',
				blocking: true,
			}
	}

	if (error.status === 429) {
		return {
			title: 'Слишком много попыток',
			description: 'Подождите немного и попробуйте снова.',
			blocking: true,
		}
	}

	if (error.status === 403) {
		return {
			title: 'Доступ запрещён',
			description: error.message ?? 'Нет прав на это действие.',
			blocking: true,
		}
	}

	return {
		title: 'Не удалось выполнить действие',
		description:
			error.message ?? 'Попробуйте ещё раз. Если проблема повторится — напишите в поддержку.',
	}
}
