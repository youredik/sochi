/**
 * Public widget POST commit — wire client (M9.widget.4 / Track A2.2).
 *
 * Uses shared `widgetBookingCommitWireInputSchema` from `@horeca/shared` —
 * single source of truth для backend route validation + frontend input shape.
 *
 * Idempotency-Key generated client-side per attempt (`crypto.randomUUID()`);
 * dedup at backend protects against double-submit (network retry, double-click).
 *
 * No auth — public surface, anonymous access. Errors mapped к taxonomy:
 *   - 400/422: validation failure (Zod or domain)
 *   - 422 (WIDGET_CONSENT_MISSING): 152-ФЗ acceptance required
 *   - 409 (STALE_AVAILABILITY): price/inventory changed since quote
 *   - 404: tenant/property/room/rate not found
 *   - 429: rate-limit exceeded → retry-after hint
 *   - 5xx: server fault
 *   - network: fetch threw before reaching server
 */

import type {
	WidgetBookingCommitErrorReason,
	WidgetBookingCommitResult,
	WidgetBookingCommitWireInput,
} from '@horeca/shared'

export type {
	WidgetBookingCommitErrorReason,
	WidgetBookingCommitResult,
	WidgetBookingCommitWireInput,
} from '@horeca/shared'

export class WidgetBookingCommitError extends Error {
	readonly reason: WidgetBookingCommitErrorReason
	readonly status: number | null
	readonly retryAfterSeconds: number | null

	constructor(
		reason: WidgetBookingCommitErrorReason,
		message: string,
		status: number | null = null,
		retryAfterSeconds: number | null = null,
	) {
		super(message)
		this.name = 'WidgetBookingCommitError'
		this.reason = reason
		this.status = status
		this.retryAfterSeconds = retryAfterSeconds
	}
}

const BASE = '/api/public/widget'

/**
 * Generate a fresh Idempotency-Key per attempt. UUID v4 via `crypto.randomUUID()`
 * (Baseline 2024 — Chrome 92+, Firefox 95+, Safari 15.4+).
 *
 * Caller pattern: `useMemo(() => generateIdempotencyKey(), [])` per-mount —
 * retries within same mount reuse same key (backend recognises replay), new
 * mounts (page reload, navigate-back) get fresh key.
 */
export function generateIdempotencyKey(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID()
	}
	const random = Math.random().toString(36).slice(2)
	return `widget-${Date.now()}-${random}`
}

/**
 * POST booking commit. Throws `WidgetBookingCommitError` для non-2xx —
 * preserves status, retry hint, machine-readable reason.
 */
export async function commitBooking(
	tenantSlug: string,
	body: WidgetBookingCommitWireInput,
	idempotencyKey: string,
): Promise<WidgetBookingCommitResult> {
	const url = `${BASE}/${encodeURIComponent(tenantSlug)}/booking`

	let res: Response
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				'Idempotency-Key': idempotencyKey,
			},
			body: JSON.stringify(body),
		})
	} catch (err) {
		throw new WidgetBookingCommitError(
			'network',
			err instanceof Error ? err.message : 'network failed',
		)
	}

	if (res.ok) {
		const json = (await res.json()) as { data: WidgetBookingCommitResult }
		return json.data
	}

	const errBody = (await res.json().catch(() => ({}))) as {
		error?: { code?: string; message?: string }
	}
	const code = errBody.error?.code ?? ''
	const message = errBody.error?.message ?? `HTTP ${res.status}`

	if (res.status === 404) {
		throw new WidgetBookingCommitError('not_found', message, res.status)
	}
	if (res.status === 409 || code === 'STALE_AVAILABILITY') {
		throw new WidgetBookingCommitError('stale_availability', message, res.status)
	}
	if (res.status === 422 && code === 'WIDGET_CONSENT_MISSING') {
		throw new WidgetBookingCommitError('consent_missing', message, res.status)
	}
	if (res.status === 400 || res.status === 422) {
		throw new WidgetBookingCommitError('validation', message, res.status)
	}
	if (res.status === 429) {
		const retryHeader = res.headers.get('Retry-After')
		const retrySec = retryHeader ? Number(retryHeader) : null
		throw new WidgetBookingCommitError(
			'rate_limited',
			message,
			res.status,
			Number.isFinite(retrySec) ? retrySec : null,
		)
	}
	throw new WidgetBookingCommitError('server', message, res.status)
}
