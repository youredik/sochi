/**
 * Shape-safe extraction of the backend's domain error envelope.
 *
 * Backend returns `{ error: { code, message } }` on 4xx/5xx, wrapped by
 * `onError` in app.ts. On network failure or non-JSON bodies the
 * fallback is a synthesized `HTTP {status}` message so downstream
 * toast+log code never handles `unknown`.
 */
export type ApiError = { code?: string; message: string }

export function extractApiError(raw: unknown): ApiError {
	if (raw && typeof raw === 'object' && 'message' in raw && typeof raw.message === 'string') {
		const code = 'code' in raw && typeof raw.code === 'string' ? raw.code : undefined
		return code ? { code, message: raw.message } : { message: raw.message }
	}
	return { message: String(raw) }
}

/** Parse a non-ok Response into an ApiError. Safe under malformed/empty body. */
export async function errorFromResponse(res: Response): Promise<ApiError> {
	const body = (await res.json().catch(() => null)) as { error?: unknown } | null
	return extractApiError(body?.error ?? { message: `HTTP ${res.status}` })
}
