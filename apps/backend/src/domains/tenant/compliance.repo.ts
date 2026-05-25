/**
 * Tenant compliance repo — read+patch RU regulatory fields on
 * `organizationProfile`. Created in M8.A.0.1 to underpin the onboarding
 * wizard (M8.A.0.6) and downstream tax/КСР workflows.
 *
 * Patch semantics (canonical in this codebase):
 *   - `undefined` ⇒ no change to the stored field.
 *   - explicit `null` ⇒ clear the field (set DB to NULL).
 *
 * No new row is ever inserted by this repo — `organizationProfile` is
 * created by the better-auth `afterCreateOrganization` hook
 * (`auth.ts`). The row's existence is the contract; this repo only
 * UPDATEs it.
 *
 * Test-coverage notes:
 *   - exactly one row per tenant (PK = organizationId)
 *   - cross-tenant isolation tested in `compliance.repo.test.ts`
 *   - cross-field invariant (`checkGuestHouseInvariant` /
 *     `checkTaxRegimeInvariant`) is enforced at the SERVICE boundary,
 *     NOT here — the repo allows partial fills так что wizard может
 *     заполнять step-by-step без блокировки на промежуточных стейтах.
 */

import type {
	KsrCategory,
	LegalEntityType,
	TenantCompliance,
	TenantCompliancePatch,
} from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import { KsrRegistryNumberMissingError } from '../../errors/domain.ts'
import { checkBookingComplianceGate } from './compliance-gate.ts'
import {
	boolOpt,
	int64Opt,
	NULL_INT64,
	NULL_TEXT,
	NULL_TIMESTAMP,
	textOpt,
	timestampOpt,
} from '../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

/**
 * Raw YDB row shape — only the compliance-relevant columns are projected.
 * `Bool?` deserializes as `boolean | null`. `Int64?` as `bigint | null`.
 */
type ComplianceRow = {
	ksrRegistryId: string | null
	ksrCategory: string | null
	legalEntityType: string | null
	taxRegime: string | null
	annualRevenueEstimateMicroRub: bigint | null
	guestHouseFz127Registered: boolean | null
	ksrVerifiedAt: Date | null
	// Sprint C+ Senior P1-5 fix 2026-05-23d: 152-ФЗ ст.9 ч.4 operator identity.
	legalAddress: string | null
	dpoEmail: string | null
	// Sprint C+ Round 6 Legal P0 fix 2026-05-24: 152-ФЗ ст.22 ч.3 п.7.1 full DPO contact.
	dpoFullName: string | null
	dpoPhone: string | null
	dpoPostalAddress: string | null
}

function rowToCompliance(r: ComplianceRow): TenantCompliance {
	return {
		ksrRegistryId: r.ksrRegistryId,
		ksrCategory: r.ksrCategory as TenantCompliance['ksrCategory'],
		legalEntityType: r.legalEntityType as TenantCompliance['legalEntityType'],
		taxRegime: r.taxRegime as TenantCompliance['taxRegime'],
		annualRevenueEstimateMicroRub: r.annualRevenueEstimateMicroRub,
		guestHouseFz127Registered: r.guestHouseFz127Registered,
		ksrVerifiedAt: r.ksrVerifiedAt ? r.ksrVerifiedAt.toISOString() : null,
		legalAddress: r.legalAddress,
		dpoEmail: r.dpoEmail,
		dpoFullName: r.dpoFullName,
		dpoPhone: r.dpoPhone,
		dpoPostalAddress: r.dpoPostalAddress,
	}
}

export type TenantComplianceRepo = ReturnType<typeof createTenantComplianceRepo>

export function createTenantComplianceRepo(sql: SqlInstance) {
	return {
		/**
		 * Read the compliance fields for a tenant. Returns `null` if the
		 * organizationProfile row does not exist (should never happen in
		 * production — invariant: row created by afterCreateOrganization
		 * hook). Tests assert this is the case.
		 */
		async get(tenantId: string): Promise<TenantCompliance | null> {
			const [rows = []] = await sql<ComplianceRow[]>`
				SELECT
					ksrRegistryId, ksrCategory, legalEntityType, taxRegime,
					annualRevenueEstimateMicroRub, guestHouseFz127Registered, ksrVerifiedAt,
					legalAddress, dpoEmail, dpoFullName, dpoPhone, dpoPostalAddress
				FROM organizationProfile
				WHERE organizationId = ${tenantId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToCompliance(row) : null
		},

		/**
		 * Sprint C+ Round 6 Legal P0 fix 2026-05-24 — initial ПП-1951 hard-gate.
		 *
		 * **Round 8 P0-6 fix 2026-05-25**: branched gate by ksrCategory +
		 * legalEntityType per `project_rf_str_msp_horeca_landscape_2026_05_25.md`.
		 * Three regulatory paths:
		 *   1. NPD (квартира посуточно самозанятый) → skip gate, выручка через
		 *      «Мой налог»; вне ПП-1951 и 127-ФЗ.
		 *   2. guest_house → 127-ФЗ от 07.06.2025 + ПП РФ 1345 — separate registry
		 *      (региональные органы, 21 регион + Сириус). Throws
		 *      `GuestHouseFz127NotRegisteredError` → HTTP 428 если
		 *      `guestHouseFz127Registered !== true`.
		 *   3. Hotel-class (hotel/aparthotel/mini_hotel/sanatorium/hostel) →
		 *      ПП-1951 КСР registry track. Throws `KsrRegistryNumberMissingError`
		 *      → HTTP 428 если ksrRegistryId пустой.
		 *
		 * Other categories (camping/tourist_center/recreation_complex/other/
		 * rest_house) AND null ksrCategory → graceful degradation: log warning,
		 * allow booking. Operator-onboarding wizard catches up later. Этот
		 * defensive choice потому что demo deploys + legacy data часто имеют
		 * incomplete compliance — blocking все incomplete profiles = worse UX
		 * чем permissive с warn-log audit trail.
		 *
		 * Branch logic isolated в `compliance-gate.ts` pure function (per Round 7
		 * v3 canon: pure-function module isolation для test imports). См.
		 * `compliance-gate.test.ts` для exhaustive branch coverage (19 tests).
		 *
		 * Format `^С\d{12}$` (Cyrillic-С + 12 digits) NOT enforced here — это
		 * UI-side validation + soft warning. Hard-gate refuses only `null` /
		 * empty / whitespace для hotel-class.
		 *
		 * Demo deployment exemption: `seed-demo-tenant.ts` populates
		 * `ksrRegistryId` с dummy `С000…` value (FAKE; legal acceptable per demo
		 * banner «не загружайте реальные данные»).
		 *
		 * **Name preserved** for callsite stability — even though scope расширен.
		 * Rename запланирован future cleanup (низкоприоритетен; semantics fixed).
		 */
		async assertKsrRegistryNumberPresent(tenantId: string): Promise<void> {
			const [rows = []] = await sql<
				[
					{
						ksrRegistryId: string | null
						ksrCategory: string | null
						legalEntityType: string | null
						guestHouseFz127Registered: boolean | null
					},
				]
			>`
				SELECT ksrRegistryId, ksrCategory, legalEntityType, guestHouseFz127Registered
				FROM organizationProfile
				WHERE organizationId = ${tenantId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			if (!row) {
				// No organizationProfile row — should never happen in production
				// (invariant: row created by afterCreateOrganization hook). Preserve
				// historical Round 6 behavior: treat absent row как «нет ksrRegistryId»
				// = throw ПП-1951 missing. Operator-friendly default; can't заранее
				// know which regulatory path applies без profile data.
				throw new KsrRegistryNumberMissingError(tenantId)
			}
			const decision = checkBookingComplianceGate(tenantId, {
				ksrRegistryId: row.ksrRegistryId,
				ksrCategory: row.ksrCategory as KsrCategory | null,
				legalEntityType: row.legalEntityType as LegalEntityType | null,
				guestHouseFz127Registered: row.guestHouseFz127Registered,
			})
			if (decision !== null) {
				throw decision
			}
			// Pass — graceful-degradation branches (null/camping/etc.) currently
			// log no warning to keep this path side-effect-free; structured-log
			// emission moved upstream к booking.service.create callsite if needed.
		},

		/**
		 * Patch the compliance fields. `undefined` keys are skipped (no
		 * change); explicit `null` clears the column.
		 *
		 * Atomic read-modify-write inside a Serializable tx: protects against
		 * concurrent wizard saves overwriting each other.
		 */
		async patch(tenantId: string, patch: TenantCompliancePatch): Promise<TenantCompliance | null> {
			return sql.begin({ idempotent: true }, async (tx) => {
				const [rows = []] = await tx<ComplianceRow[]>`
					SELECT
						ksrRegistryId, ksrCategory, legalEntityType, taxRegime,
						annualRevenueEstimateMicroRub, guestHouseFz127Registered, ksrVerifiedAt,
						legalAddress, dpoEmail, dpoFullName, dpoPhone, dpoPostalAddress
					FROM organizationProfile
					WHERE organizationId = ${tenantId}
					LIMIT 1
				`
				const row = rows[0]
				if (!row) return null

				// Three-state merge: `undefined` ⇒ keep current; `null` or value
				// ⇒ overwrite.
				const merged: TenantCompliance = {
					ksrRegistryId:
						'ksrRegistryId' in patch && patch.ksrRegistryId !== undefined
							? patch.ksrRegistryId
							: row.ksrRegistryId,
					ksrCategory:
						'ksrCategory' in patch && patch.ksrCategory !== undefined
							? patch.ksrCategory
							: (row.ksrCategory as TenantCompliance['ksrCategory']),
					legalEntityType:
						'legalEntityType' in patch && patch.legalEntityType !== undefined
							? patch.legalEntityType
							: (row.legalEntityType as TenantCompliance['legalEntityType']),
					taxRegime:
						'taxRegime' in patch && patch.taxRegime !== undefined
							? patch.taxRegime
							: (row.taxRegime as TenantCompliance['taxRegime']),
					annualRevenueEstimateMicroRub:
						'annualRevenueEstimateMicroRub' in patch &&
						patch.annualRevenueEstimateMicroRub !== undefined
							? patch.annualRevenueEstimateMicroRub
							: row.annualRevenueEstimateMicroRub,
					guestHouseFz127Registered:
						'guestHouseFz127Registered' in patch && patch.guestHouseFz127Registered !== undefined
							? patch.guestHouseFz127Registered
							: row.guestHouseFz127Registered,
					ksrVerifiedAt:
						'ksrVerifiedAt' in patch && patch.ksrVerifiedAt !== undefined
							? patch.ksrVerifiedAt
							: row.ksrVerifiedAt
								? row.ksrVerifiedAt.toISOString()
								: null,
					legalAddress:
						'legalAddress' in patch && patch.legalAddress !== undefined
							? patch.legalAddress
							: row.legalAddress,
					dpoEmail:
						'dpoEmail' in patch && patch.dpoEmail !== undefined ? patch.dpoEmail : row.dpoEmail,
					// Sprint C+ Round 6 Legal P0 fix 2026-05-24 — 152-ФЗ ст.22 ч.3 п.7.1 full DPO.
					dpoFullName:
						'dpoFullName' in patch && patch.dpoFullName !== undefined
							? patch.dpoFullName
							: row.dpoFullName,
					dpoPhone:
						'dpoPhone' in patch && patch.dpoPhone !== undefined ? patch.dpoPhone : row.dpoPhone,
					dpoPostalAddress:
						'dpoPostalAddress' in patch && patch.dpoPostalAddress !== undefined
							? patch.dpoPostalAddress
							: row.dpoPostalAddress,
				}

				const ksrVerifiedAtBind = merged.ksrVerifiedAt
					? timestampOpt(new Date(merged.ksrVerifiedAt))
					: NULL_TIMESTAMP
				await tx`
					UPDATE organizationProfile SET
						ksrRegistryId = ${textOpt(merged.ksrRegistryId)},
						ksrCategory = ${textOpt(merged.ksrCategory)},
						legalEntityType = ${textOpt(merged.legalEntityType)},
						taxRegime = ${textOpt(merged.taxRegime)},
						annualRevenueEstimateMicroRub = ${int64Opt(merged.annualRevenueEstimateMicroRub)},
						guestHouseFz127Registered = ${boolOpt(merged.guestHouseFz127Registered)},
						ksrVerifiedAt = ${ksrVerifiedAtBind},
						legalAddress = ${textOpt(merged.legalAddress)},
						dpoEmail = ${textOpt(merged.dpoEmail)},
						dpoFullName = ${textOpt(merged.dpoFullName)},
						dpoPhone = ${textOpt(merged.dpoPhone)},
						dpoPostalAddress = ${textOpt(merged.dpoPostalAddress)},
						updatedAt = CurrentUtcTimestamp()
					WHERE organizationId = ${tenantId}
				`
				return merged
			})
		},
	}
}

// Re-export typed null helpers so the repo's test file can build deterministic
// fixtures without re-importing every helper individually.
export { NULL_INT64, NULL_TEXT, NULL_TIMESTAMP }
