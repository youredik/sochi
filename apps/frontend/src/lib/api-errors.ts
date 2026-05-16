/**
 * Shape-safe extraction of the backend's domain error envelope.
 *
 * Backend returns `{ error: { code, message } }` on 4xx/5xx, wrapped by
 * `onError` in app.ts. On network failure or non-JSON bodies the
 * fallback is a synthesized `HTTP {status}` message so downstream
 * toast+log code never handles `unknown`.
 */
export type ApiError = { code?: string; message: string; statusCode?: number }

export function extractApiError(raw: unknown): ApiError {
	if (raw && typeof raw === 'object' && 'message' in raw && typeof raw.message === 'string') {
		const code = 'code' in raw && typeof raw.code === 'string' ? raw.code : undefined
		const statusCode =
			'statusCode' in raw && typeof raw.statusCode === 'number' ? raw.statusCode : undefined
		const out: ApiError = code ? { code, message: raw.message } : { message: raw.message }
		if (statusCode !== undefined) out.statusCode = statusCode
		return out
	}
	return { message: String(raw) }
}

/** Parse a non-ok Response into an ApiError. Safe under malformed/empty body.
 *  G11 (2026-05-16): includes `statusCode` so offline-mutation hook can
 *  route к correct queue status (409 / 422 / network). */
export async function errorFromResponse(res: Response): Promise<ApiError> {
	const body = (await res.json().catch(() => null)) as { error?: unknown } | null
	const inner = body?.error ?? { message: `HTTP ${res.status}` }
	const err = extractApiError(inner)
	err.statusCode = res.status
	return err
}
