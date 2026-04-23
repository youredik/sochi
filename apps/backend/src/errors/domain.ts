/**
 * Domain error hierarchy. All thrown from service/repo layer carry a stable
 * `code` that the global `onError` handler maps to HTTP status via
 * `http-mapping.ts`. Routes should NEVER do per-error try/catch; throw at the
 * lowest meaningful layer and let the handler translate.
 *
 * Pattern adapted from stankoff-v2/apps/backend/src/errors/.
 *
 * Base classes (`DomainError`, `ConflictError`, …) are added only when there is
 * at least one concrete subclass using them — YAGNI by default, recreate when
 * the next domain needs them.
 */

export abstract class DomainError extends Error {
	abstract readonly code: string
}

export class NotFoundError extends DomainError {
	readonly code = 'NOT_FOUND'
	constructor(entity: string, id: string) {
		super(`${entity} not found: ${id}`)
		this.name = 'NotFoundError'
	}
}

/** Base for UNIQUE/exclusivity conflicts. Concrete subclasses set a narrower code. */
abstract class ConflictError extends DomainError {
	readonly code: string = 'CONFLICT'
}

/** `(tenantId, propertyId, number)` UNIQUE index violation on `room`. */
export class RoomNumberTakenError extends ConflictError {
	override readonly code = 'ROOM_NUMBER_TAKEN'
	constructor(number: string) {
		super(`Room number already taken in this property: ${number}`)
		this.name = 'RoomNumberTakenError'
	}
}

/** Parent property missing (cross-tenant or deleted). Surfaced by roomType/room services. */
export class PropertyNotFoundError extends NotFoundError {
	constructor(propertyId: string) {
		super('Property', propertyId)
		this.name = 'PropertyNotFoundError'
	}
}

/** Parent roomType missing (cross-tenant or deleted). Surfaced by room service. */
export class RoomTypeNotFoundError extends NotFoundError {
	constructor(roomTypeId: string) {
		super('RoomType', roomTypeId)
		this.name = 'RoomTypeNotFoundError'
	}
}

/**
 * `(tenantId, propertyId, code)` uniqueness violation on `ratePlan`.
 * App-level enforcement (see `project_ydb_specifics.md` #12 — YDB won't let
 * us add UNIQUE indexes after CREATE TABLE, so we SELECT-before-UPSERT in tx).
 */
export class RatePlanCodeTakenError extends ConflictError {
	override readonly code = 'RATE_PLAN_CODE_TAKEN'
	constructor(code: string) {
		super(`Rate plan code already taken in this property: ${code}`)
		this.name = 'RatePlanCodeTakenError'
	}
}

/** Parent ratePlan missing or in wrong tenant. Surfaced by rate service. */
export class RatePlanNotFoundError extends NotFoundError {
	constructor(ratePlanId: string) {
		super('RatePlan', ratePlanId)
		this.name = 'RatePlanNotFoundError'
	}
}

/** Parent booking missing or in wrong tenant. */
export class BookingNotFoundError extends NotFoundError {
	constructor(bookingId: string) {
		super('Booking', bookingId)
		this.name = 'BookingNotFoundError'
	}
}

/**
 * Requested date range has no availability row, is stop-sold, or insufficient
 * `allotment - sold` for +1 booking. Raised by booking.create() before any
 * UPSERT so the tx can be rolled back cleanly.
 */
export class NoInventoryError extends ConflictError {
	override readonly code = 'NO_INVENTORY'
	constructor(details: string) {
		super(`No inventory available: ${details}`)
		this.name = 'NoInventoryError'
	}
}

/**
 * Attempt to transition a booking through a forbidden edge (e.g. cancel a
 * no-show, check-in a cancelled booking, mark no-show on checked-out). The
 * 5-state machine is terminal at `cancelled`/`checked_out`/`no_show`; `no_show`
 * additionally forbids reverse transitions (fraud protection).
 */
export class InvalidBookingTransitionError extends ConflictError {
	override readonly code = 'INVALID_BOOKING_TRANSITION'
	constructor(from: string, to: string) {
		super(`Cannot transition booking from '${from}' to '${to}'`)
		this.name = 'InvalidBookingTransitionError'
	}
}

/** UNIQUE `(tenantId, propertyId, externalId)` violation (OTA retry with different body). */
export class BookingExternalIdTakenError extends ConflictError {
	override readonly code = 'BOOKING_EXTERNAL_ID_TAKEN'
	constructor(externalId: string) {
		super(`Booking with externalId already exists in this property: ${externalId}`)
		this.name = 'BookingExternalIdTakenError'
	}
}

/**
 * Same `Idempotency-Key` replayed with a different request body (fingerprint
 * mismatch). Per IETF `draft-ietf-httpapi-idempotency-key-header-07` §2.7
 * this MUST return 422 — the client is misusing the key.
 */
export class IdempotencyKeyConflictError extends ConflictError {
	override readonly code = 'IDEMPOTENCY_KEY_CONFLICT'
	constructor(key: string) {
		super(`Idempotency-Key '${key}' was already used with a different request body`)
		this.name = 'IdempotencyKeyConflictError'
	}
}

// IdempotencyKeyInProgressError (409) deferred to Phase 3 — requires a
// true concurrent-detection mechanism (row-lock or 'processing' sentinel).
// первый этап толерирует the thin race window between SELECT-and-UPSERT in the
// idempotency middleware; revisit when real traffic shows contention.
