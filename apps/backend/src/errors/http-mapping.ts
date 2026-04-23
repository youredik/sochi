import type { ContentfulStatusCode } from 'hono/utils/http-status'

/**
 * Maps `DomainError.code` → HTTP status. Unknown codes fall through to 500.
 * Every domain-specific code (e.g. `ROOM_NUMBER_TAKEN`) must be registered
 * here — this is the single source of truth for status codes.
 *
 * `ContentfulStatusCode` excludes 101/204 (no-body statuses) so the value
 * is always safe to pass to `c.json(body, status)`.
 */
export const HTTP_STATUS_MAP: Record<string, ContentfulStatusCode> = {
	NOT_FOUND: 404,
	VALIDATION_ERROR: 400,
	CONFLICT: 409,
	ROOM_NUMBER_TAKEN: 409,
	RATE_PLAN_CODE_TAKEN: 409,
	BOOKING_EXTERNAL_ID_TAKEN: 409,
	INVALID_BOOKING_TRANSITION: 409,
	NO_INVENTORY: 409,
	IDEMPOTENCY_KEY_CONFLICT: 422,
	FORBIDDEN: 403,
}
