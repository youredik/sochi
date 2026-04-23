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
