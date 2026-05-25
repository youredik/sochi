/**
 * Round 8 P0-6 fix 2026-05-25 — pure-function compliance gate for booking.create.
 *
 * **Why pure function** (per Round 7 v3 canon: pure-function module isolation
 * для test imports): the prior `assertKsrRegistryNumberPresent` threaded SQL
 * + branching logic together → impossible to unit-test branches without DB.
 * Splitting into a 0-side-effect `checkBookingComplianceGate(row)` lets us
 * exhaustively verify all 4 regulatory paths without spinning YDB.
 *
 * **3 regulatory paths** (per `project_rf_str_msp_horeca_landscape_2026_05_25.md`):
 *
 * | Tenant shape | ksrCategory | legalEntityType | guestHouseFz127Registered | Required preconditions |
 * |---|---|---|---|---|
 * | **Гостиница / отель** (federal, ПП-1951) | hotel/aparthotel/sanatorium/mini_hotel/hostel | ip/ooo/ao | (n/a) | `ksrRegistryId` non-empty |
 * | **Гостевой дом** (21 регион + Сириус, 127-ФЗ) | guest_house | ip/ooo | === `true` | flag must be `true` |
 * | **Квартира посуточно НПД** (самозанятый) | (any/null) | npd | (n/a) | none — skip gate |
 * | **Прочее** (camping, tourist_center, etc., null) | other-non-hotel-class | any non-npd | (n/a) | none — graceful warn |
 *
 * Branch precedence (top-to-bottom):
 *   1. `legalEntityType === 'npd'` → return null (skip)
 *   2. `ksrCategory === 'guest_house'` → require `guestHouseFz127Registered === true`
 *   3. `ksrCategory ∈ HOTEL_LIKE_KSR_CATEGORIES` → require non-empty `ksrRegistryId`
 *   4. else → return null (graceful — unknown classification, log at callsite)
 *
 * Returns `null` when gate passes; returns a typed `DomainError` instance when
 * gate denies. Callsite is responsible for `throw` (allows the repo to log
 * warnings on graceful-degradation branches without throwing).
 *
 * Reference canons:
 *   - `feedback_ksr_pp_1951_canon_2026_05_24.md` — ПП-1951 hotel registry
 *   - `project_rf_str_msp_horeca_landscape_2026_05_25.md` — 3 regulatory paths
 *   - `feedback_pp_1912_hotel_canon_2026_05_23.md` — отель context vs КСР
 */

import type { KsrCategory, LegalEntityType } from '@horeca/shared'
import {
	GuestHouseFz127NotRegisteredError,
	KsrRegistryNumberMissingError,
} from '../../errors/domain.ts'

/**
 * Categories subject to ПП-1951 от 27.12.2024 (ред. 27.11.2025) КСР registry.
 *
 * Selected per task spec (Round 8 P0-6): hotel-class accommodations that
 * require Росаккредитация ФГИС «Гостеприимство» реестровый номер. NOT
 * `guest_house` (own 127-ФЗ path); NOT `camping`/`tourist_center`/`other`
 * (graceful — outside the strict registry regime, operator warned but
 * NOT blocked from accepting bookings — see graceful-degradation canon).
 *
 * **Closed enum** — adding a new ksrCategoryValue здесь требует explicit
 * regulatory-path decision (которая дорожка применима). Default = graceful.
 */
export const HOTEL_LIKE_KSR_CATEGORIES: ReadonlySet<KsrCategory> = new Set<KsrCategory>([
	'hotel',
	'aparthotel',
	'mini_hotel',
	'sanatorium',
	'hostel',
])

/**
 * Slice of organizationProfile fields the gate reads. Caller projects from
 * SQL row; we keep types narrow (only these 4 columns matter to gate logic).
 */
export interface ComplianceGateInput {
	readonly ksrRegistryId: string | null
	readonly ksrCategory: KsrCategory | null
	readonly legalEntityType: LegalEntityType | null
	readonly guestHouseFz127Registered: boolean | null
}

/**
 * Pure-function gate. Returns `null` ⇒ pass; returns a `DomainError` instance
 * ⇒ deny (caller `throw`s). Never throws itself, never reads/writes any
 * external state — fully unit-testable.
 *
 * `tenantId` parameter is only used для embedding в error.message (for
 * operator-friendly diagnostics в logs / 428 response body).
 */
export function checkBookingComplianceGate(
	tenantId: string,
	input: ComplianceGateInput,
): KsrRegistryNumberMissingError | GuestHouseFz127NotRegisteredError | null {
	// Branch 1: NPD short-circuit — самозанятый apartment-rental вне обоих
	// реестров. Канонически skip GATE entirely. Wins over ksrCategory column
	// if both are populated (edge case: operator misfilled — НПД precedence
	// per task spec since fiscal regime drives регуляторный путь).
	if (input.legalEntityType === 'npd') {
		return null
	}

	// Branch 2: Guest house — 127-ФЗ separate registry track.
	if (input.ksrCategory === 'guest_house') {
		if (input.guestHouseFz127Registered === true) {
			return null
		}
		// false OR null → block. Null = unknown = не подтверждено = блок до
		// явного подтверждения (защита от silent-allow legacy data).
		return new GuestHouseFz127NotRegisteredError(tenantId)
	}

	// Branch 3: Hotel-class — ПП-1951 КСР registry track.
	if (input.ksrCategory !== null && HOTEL_LIKE_KSR_CATEGORIES.has(input.ksrCategory)) {
		const value = input.ksrRegistryId?.trim() ?? ''
		if (value.length === 0) {
			return new KsrRegistryNumberMissingError(tenantId)
		}
		return null
	}

	// Branch 4: graceful degradation — null category, или non-hotel-non-guest-
	// house category (camping, tourist_center, recreation_complex, other,
	// rest_house). Callsite SHOULD log a warning so operator-onboarding can
	// classify the tenant correctly later. Bookings allowed since the regime
	// is неопределён / outside both strict registries.
	return null
}
