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
	INVALID_BOOKING_AMEND_STATE: 409,
	ROOM_ASSIGNMENT_CONFLICT: 409,
	NO_INVENTORY: 409,
	IDEMPOTENCY_KEY_CONFLICT: 422,
	FORBIDDEN: 403,
	// Folio domain (M6, see project_payment_domain_canonical.md)
	INVALID_FOLIO_TRANSITION: 409,
	FOLIO_HAS_DRAFT_LINES: 409,
	FOLIO_CURRENCY_MISMATCH: 409,
	INVALID_FOLIO_LINE_TRANSITION: 409,
	FOLIO_VERSION_CONFLICT: 409,
	// Payment domain (M6.2)
	INVALID_PAYMENT_TRANSITION: 409,
	PAYMENT_VERSION_CONFLICT: 409,
	PAYMENT_IDEMPOTENCY_KEY_TAKEN: 409,
	PROVIDER_PAYMENT_ID_TAKEN: 409,
	// Refund domain (M6.3)
	INVALID_REFUND_TRANSITION: 409,
	REFUND_VERSION_CONFLICT: 409,
	REFUND_EXCEEDS_CAPTURE: 422,
	REFUND_CAUSALITY_COLLISION: 409,
	PROVIDER_REFUND_ID_TAKEN: 409,
	// Widget booking-create (M9.widget.4)
	STALE_AVAILABILITY: 409,
	WIDGET_CONSENT_MISSING: 422,
	// PropertyBlock / OOO (G9 2026-05-16)
	PROPERTY_BLOCK_BOOKING_CONFLICT: 409,
	PROPERTY_BLOCK_BLOCK_OVERLAP: 409,
	PROPERTY_BLOCK_PAST_IMMUTABLE: 409,
	// ПП-1951 КСР registry gate (Sprint C+ Round 6 Legal P0 2026-05-24).
	// 428 Precondition Required — server insists on completing missing
	// precondition (реестровый номер) before honoring booking.create.
	KSR_REGISTRY_NUMBER_MISSING: 428,
	// 109-ФЗ ст. 22 ч. 3 + ПП РФ № 9 — passport scan required before check-in
	// для foreign citizens (Sprint C+ Round 7 Senior P0 2026-05-24). Mirrors
	// frontend booking-edit-sheet hard-gate. Штраф ст. 18.9 КоАП 400-500k ₽.
	PASSPORT_SCAN_REQUIRED: 428,
	// 127-ФЗ от 07.06.2025 + ПП РФ 1345 от 30.08.2025 — guest house registry
	// gate (Round 8 P0-6 2026-05-25). Separate regulatory regime от ПП-1951;
	// guest_house tenants должны быть зарегистрированы в реестре эксперимента
	// в 21 регионе + Сириус. 428 Precondition Required (mirrors ПП-1951
	// semantic: client must complete missing precondition).
	GUEST_HOUSE_FZ127_NOT_REGISTERED: 428,
}
