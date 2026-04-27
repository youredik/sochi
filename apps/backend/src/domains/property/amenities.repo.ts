/**
 * Property amenities repo. M:N assignment of canonical amenities (catalog
 * lives in `@horeca/shared/amenities.ts`) to a property.
 *
 * Service-layer guarantees (callers MUST validate before calling repo):
 *   1. `amenityCode` is in the canonical catalog (Zod
 *      `propertyAmenityInputSchema` enforces this).
 *   2. `value` invariant is satisfied (Zod refinement +
 *      `checkAmenityValueInvariant`).
 *   3. The `scope` denormalized into the row matches the catalog entry's
 *      scope — repo derives it from the catalog (caller doesn't pass it).
 *
 * Atomicity:
 *   - `setMany(tenantId, propertyId, inputs[])` replaces the full set in a
 *     single Serializable tx — partial-write impossible. Concurrent saves
 *     conflict; one wins, the other retries via @ydbjs/retry. Critical
 *     for wizard «Save all amenities» button.
 *   - Single `add` / `remove` are non-atomic (each runs as its own session).
 */

import { getAmenity, type PropertyAmenityInput, type PropertyAmenityRow } from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import { textOpt } from '../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

type AmenityDbRow = {
	tenantId: string
	propertyId: string
	amenityCode: string
	scope: string
	freePaid: string
	value: string | null
	createdAt: Date
	updatedAt: Date
}

function rowToAmenity(r: AmenityDbRow): PropertyAmenityRow {
	return {
		tenantId: r.tenantId,
		propertyId: r.propertyId,
		amenityCode: r.amenityCode,
		scope: r.scope as PropertyAmenityRow['scope'],
		freePaid: r.freePaid as PropertyAmenityRow['freePaid'],
		value: r.value,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
	}
}

export function createAmenitiesRepo(sql: SqlInstance) {
	return {
		/**
		 * List all amenities of a property. Returns rows sorted by
		 * `amenityCode` for deterministic UI rendering.
		 */
		async listByProperty(tenantId: string, propertyId: string): Promise<PropertyAmenityRow[]> {
			const [rows = []] = await sql<AmenityDbRow[]>`
				SELECT *
				FROM propertyAmenity
				WHERE tenantId = ${tenantId} AND propertyId = ${propertyId}
				ORDER BY amenityCode
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToAmenity)
		},

		/**
		 * Idempotent UPSERT of a single amenity. Re-calling with the same
		 * (tenantId, propertyId, amenityCode) updates `freePaid`/`value`/
		 * `updatedAt` but preserves `createdAt`/`createdBy`.
		 */
		async upsert(
			tenantId: string,
			propertyId: string,
			input: PropertyAmenityInput,
			actorId: string,
		): Promise<PropertyAmenityRow> {
			const def = getAmenity(input.amenityCode)
			if (def === null) {
				throw new Error(`Unknown amenity code: ${input.amenityCode}`)
			}

			return sql.begin(async (tx) => {
				const [existingRows = []] = await tx<AmenityDbRow[]>`
					SELECT *
					FROM propertyAmenity
					WHERE tenantId = ${tenantId}
					  AND propertyId = ${propertyId}
					  AND amenityCode = ${input.amenityCode}
					LIMIT 1
				`
				const existing = existingRows[0]
				const now = new Date()
				const createdAt = existing ? existing.createdAt : now
				const value = input.value ?? null
				if (existing) {
					// Preserve createdAt/createdBy via targeted UPDATE.
					await tx`
						UPDATE propertyAmenity SET
							freePaid = ${input.freePaid},
							value = ${textOpt(value)},
							updatedAt = ${now},
							updatedBy = ${actorId}
						WHERE tenantId = ${tenantId}
						  AND propertyId = ${propertyId}
						  AND amenityCode = ${input.amenityCode}
					`
				} else {
					await tx`
						UPSERT INTO propertyAmenity (
							\`tenantId\`, \`propertyId\`, \`amenityCode\`,
							\`scope\`, \`freePaid\`, \`value\`,
							\`createdAt\`, \`createdBy\`, \`updatedAt\`, \`updatedBy\`
						) VALUES (
							${tenantId}, ${propertyId}, ${input.amenityCode},
							${def.scope}, ${input.freePaid}, ${textOpt(value)},
							${now}, ${actorId}, ${now}, ${actorId}
						)
					`
				}

				return {
					tenantId,
					propertyId,
					amenityCode: input.amenityCode,
					scope: def.scope,
					freePaid: input.freePaid,
					value,
					createdAt: createdAt.toISOString(),
					updatedAt: now.toISOString(),
				}
			})
		},

		/**
		 * Remove a single amenity assignment. Returns true if a row was
		 * deleted, false if it didn't exist (for idempotency).
		 */
		async remove(tenantId: string, propertyId: string, amenityCode: string): Promise<boolean> {
			const [rowsBefore = []] = await sql<{ x: number }[]>`
				SELECT 1 AS x
				FROM propertyAmenity
				WHERE tenantId = ${tenantId}
				  AND propertyId = ${propertyId}
				  AND amenityCode = ${amenityCode}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			if (rowsBefore.length === 0) return false
			await sql`
				DELETE FROM propertyAmenity
				WHERE tenantId = ${tenantId}
				  AND propertyId = ${propertyId}
				  AND amenityCode = ${amenityCode}
			`
			return true
		},

		/**
		 * Atomic full-replace: deletes all current amenities for the property
		 * and writes the given set. Either all changes commit, or none do.
		 *
		 * Use case: «Save» button in the amenities admin panel — operator
		 * selects/deselects checkboxes and we persist the resulting set as
		 * a single transaction.
		 */
		async setMany(
			tenantId: string,
			propertyId: string,
			inputs: readonly PropertyAmenityInput[],
			actorId: string,
		): Promise<PropertyAmenityRow[]> {
			// Validate every input upfront — fail fast outside the tx so we
			// don't open a writer connection just to throw. Service layer
			// SHOULD already have validated, but defense-in-depth.
			for (const i of inputs) {
				if (getAmenity(i.amenityCode) === null) {
					throw new Error(`Unknown amenity code: ${i.amenityCode}`)
				}
			}
			// Reject duplicate codes inside the same set (would otherwise be
			// non-deterministic which one wins).
			const codes = new Set<string>()
			for (const i of inputs) {
				if (codes.has(i.amenityCode)) {
					throw new Error(`Duplicate amenity code in set: ${i.amenityCode}`)
				}
				codes.add(i.amenityCode)
			}

			return sql.begin(async (tx) => {
				await tx`
					DELETE FROM propertyAmenity
					WHERE tenantId = ${tenantId} AND propertyId = ${propertyId}
				`
				if (inputs.length === 0) return []
				const now = new Date()
				// One UPSERT per row. Future optimization: batched VALUES (..)(..)
				// once @ydbjs/query supports it for parameterized batches.
				for (const i of inputs) {
					const def = getAmenity(i.amenityCode)
					if (def === null) throw new Error(`Unknown amenity code: ${i.amenityCode}`) // unreachable
					await tx`
						UPSERT INTO propertyAmenity (
							\`tenantId\`, \`propertyId\`, \`amenityCode\`,
							\`scope\`, \`freePaid\`, \`value\`,
							\`createdAt\`, \`createdBy\`, \`updatedAt\`, \`updatedBy\`
						) VALUES (
							${tenantId}, ${propertyId}, ${i.amenityCode},
							${def.scope}, ${i.freePaid}, ${textOpt(i.value ?? null)},
							${now}, ${actorId}, ${now}, ${actorId}
						)
					`
				}
				const [rows = []] = await tx<AmenityDbRow[]>`
					SELECT *
					FROM propertyAmenity
					WHERE tenantId = ${tenantId} AND propertyId = ${propertyId}
					ORDER BY amenityCode
				`
				return rows.map(rowToAmenity)
			})
		},
	}
}
