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

import type { TenantCompliance, TenantCompliancePatch } from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
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
	}
}

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
					legalAddress, dpoEmail
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
						annualRevenueEstimateMicroRub, guestHouseFz127Registered, ksrVerifiedAt
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
