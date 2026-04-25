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

/* ============================================================== Folio errors */

/** Parent folio missing or wrong tenant. Surfaced by folio service / line ops. */
export class FolioNotFoundError extends NotFoundError {
	constructor(folioId: string) {
		super('Folio', folioId)
		this.name = 'FolioNotFoundError'
	}
}

/**
 * Attempt to transition a folio through a forbidden edge.
 * Folio SM: open → closed → settled. closed→open exists but only via supervisor
 * RBAC + 24h window (the SOLE non-monotonic edge in the entire payment domain;
 * see memory `project_payment_domain_canonical.md`).
 */
export class InvalidFolioTransitionError extends ConflictError {
	override readonly code = 'INVALID_FOLIO_TRANSITION'
	constructor(from: string, to: string) {
		super(`Cannot transition folio from '${from}' to '${to}'`)
		this.name = 'InvalidFolioTransitionError'
	}
}

/**
 * Folio close attempted while it has draft (unposted) lines.
 * Invariant #4 (folio-close-no-pending-lines): close requires
 * `COUNT(folioLines WHERE lineStatus='draft') = 0`.
 */
export class FolioHasDraftLinesError extends ConflictError {
	override readonly code = 'FOLIO_HAS_DRAFT_LINES'
	constructor(folioId: string, draftCount: number) {
		super(`Cannot close folio ${folioId}: ${draftCount} draft line(s) pending`)
		this.name = 'FolioHasDraftLinesError'
	}
}

/**
 * Currency mismatch when posting to a folio (invariant #14:
 * Payment.currency = Folio.currency at insert time).
 */
export class FolioCurrencyMismatchError extends ConflictError {
	override readonly code = 'FOLIO_CURRENCY_MISMATCH'
	constructor(expected: string, got: string) {
		super(`Folio currency is ${expected}; cannot post line in ${got}`)
		this.name = 'FolioCurrencyMismatchError'
	}
}

/**
 * Attempt to post / void / re-post a folio line through a forbidden sub-state edge.
 * FolioLine SM: draft → posted → void. Once `void`, line is terminal.
 */
export class InvalidFolioLineTransitionError extends ConflictError {
	override readonly code = 'INVALID_FOLIO_LINE_TRANSITION'
	constructor(from: string, to: string) {
		super(`Cannot transition folio line from '${from}' to '${to}'`)
		this.name = 'InvalidFolioLineTransitionError'
	}
}

/**
 * OCC version mismatch on folio / folioLine. Caller should re-read and retry.
 * Surfaces a stable error to upstream so middleware can apply bounded retry
 * (3-5 attempts with jittered backoff) per the canonical concurrency policy.
 */
export class FolioVersionConflictError extends ConflictError {
	override readonly code = 'FOLIO_VERSION_CONFLICT'
	constructor(folioId: string, expected: number, got: number) {
		super(`Folio ${folioId} version mismatch: expected ${expected}, found ${got}`)
		this.name = 'FolioVersionConflictError'
	}
}

/* ============================================================ Payment errors */

/** Parent payment missing or wrong tenant. */
export class PaymentNotFoundError extends NotFoundError {
	constructor(paymentId: string) {
		super('Payment', paymentId)
		this.name = 'PaymentNotFoundError'
	}
}

/**
 * Forbidden Payment SM transition (canon: created → pending → waiting_for_capture
 * → succeeded → partially_refunded → refunded; terminal: failed/canceled/expired/refunded).
 */
export class InvalidPaymentTransitionError extends ConflictError {
	override readonly code = 'INVALID_PAYMENT_TRANSITION'
	constructor(from: string, to: string) {
		super(`Cannot transition payment from '${from}' to '${to}'`)
		this.name = 'InvalidPaymentTransitionError'
	}
}

/** OCC version mismatch on payment. */
export class PaymentVersionConflictError extends ConflictError {
	override readonly code = 'PAYMENT_VERSION_CONFLICT'
	constructor(paymentId: string, expected: number, got: number) {
		super(`Payment ${paymentId} version mismatch: expected ${expected}, found ${got}`)
		this.name = 'PaymentVersionConflictError'
	}
}

/**
 * Tenant-scoped UNIQUE collision on `(tenantId, idempotencyKey)`.
 * Distinct from `IdempotencyKeyConflictError` (the IETF-style "same key,
 * different body"): this fires when the application layer detects a key
 * collision before checking body match — used as a router-level dedup signal.
 */
export class PaymentIdempotencyKeyTakenError extends ConflictError {
	override readonly code = 'PAYMENT_IDEMPOTENCY_KEY_TAKEN'
	constructor(key: string) {
		super(`Payment with idempotencyKey already exists: ${key}`)
		this.name = 'PaymentIdempotencyKeyTakenError'
	}
}

/**
 * Tenant-scoped UNIQUE collision on `(tenantId, providerCode, providerPaymentId)`.
 * Surfaces when a provider webhook attempts to register a paymentId already
 * tied to a different local payment (provider-side data corruption signal).
 */
export class ProviderPaymentIdTakenError extends ConflictError {
	override readonly code = 'PROVIDER_PAYMENT_ID_TAKEN'
	constructor(providerCode: string, providerPaymentId: string) {
		super(`Provider ${providerCode} payment id already taken: ${providerPaymentId}`)
		this.name = 'ProviderPaymentIdTakenError'
	}
}

/* ============================================================ Refund errors */

/** Parent refund missing or wrong tenant. */
export class RefundNotFoundError extends NotFoundError {
	constructor(refundId: string) {
		super('Refund', refundId)
		this.name = 'RefundNotFoundError'
	}
}

/**
 * Forbidden Refund SM transition. Refund SM:
 *   pending → succeeded | failed; both terminal.
 */
export class InvalidRefundTransitionError extends ConflictError {
	override readonly code = 'INVALID_REFUND_TRANSITION'
	constructor(from: string, to: string) {
		super(`Cannot transition refund from '${from}' to '${to}'`)
		this.name = 'InvalidRefundTransitionError'
	}
}

/** OCC version mismatch on refund. */
export class RefundVersionConflictError extends ConflictError {
	override readonly code = 'REFUND_VERSION_CONFLICT'
	constructor(refundId: string, expected: number, got: number) {
		super(`Refund ${refundId} version mismatch: expected ${expected}, found ${got}`)
		this.name = 'RefundVersionConflictError'
	}
}

/**
 * Canon invariant #1 (refund-cumulative-cap): cumulative `SUM(refunds.succeeded)`
 * MUST NOT exceed `payment.capturedMinor`. Throws BEFORE provider call so the
 * tx rolls back cleanly.
 */
export class RefundExceedsCaptureError extends ConflictError {
	override readonly code = 'REFUND_EXCEEDS_CAPTURE'
	constructor(capturedMinor: bigint, attemptedMinor: bigint) {
		super(
			`Refund exceeds captured: attempted ${attemptedMinor} kop., captured ${capturedMinor} kop.`,
		)
		this.name = 'RefundExceedsCaptureError'
	}
}

/**
 * UNIQUE collision on `(tenantId, causalityId)`. Surfaces when two refund
 * requests target the same causality (e.g. dispute-lost would auto-create
 * a refund with `dispute:<id>` causality; user.refund attempts the same
 * causality string → blocked).
 */
export class RefundCausalityCollisionError extends ConflictError {
	override readonly code = 'REFUND_CAUSALITY_COLLISION'
	constructor(causalityId: string) {
		super(`Refund causality already taken: ${causalityId}`)
		this.name = 'RefundCausalityCollisionError'
	}
}

/** UNIQUE collision on `(tenantId, providerCode, providerRefundId)`. */
export class ProviderRefundIdTakenError extends ConflictError {
	override readonly code = 'PROVIDER_REFUND_ID_TAKEN'
	constructor(providerRefundId: string) {
		super(`Provider refund id already taken: ${providerRefundId}`)
		this.name = 'ProviderRefundIdTakenError'
	}
}
