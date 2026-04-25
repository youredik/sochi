import { z } from 'zod'

/**
 * Activity — polymorphic audit log. Populated ONLY by the CDC consumer
 * (apps/backend/src/workers/cdc-consumer.ts) by diffing oldImage/newImage
 * of every domain table that has a CHANGEFEED. No business code ever
 * inserts into `activity` directly.
 *
 * Canonical event types:
 *   - 'created' — single row per INSERT, diffJson = { fields: newImage }
 *   - 'statusChange' — special-cased when `status` column differs, one row
 *     per state transition, diffJson = { field:'status', old, new }
 *   - 'fieldChange' — one row PER changed non-system field on UPDATE,
 *     diffJson = { field, old, new }
 *   - 'deleted' — one row per DELETE, diffJson = { fields: oldImage }
 *
 * TTL = 730 days (2 years) aligned with 152-ФЗ audit retention; fiscal
 * records live in folio, not here.
 */

const activityObjectTypeValues = [
	'booking',
	'property',
	'roomType',
	'room',
	'ratePlan',
	'availability',
	'rate',
	'guest',
	// Payment domain (M6.5, 2026-04-25 — see project_payment_domain_canonical.md)
	'folio',
	'payment',
	'refund',
	'receipt',
	'dispute',
] as const
export const activityObjectTypeSchema = z.enum(activityObjectTypeValues)
export type ActivityObjectType = z.infer<typeof activityObjectTypeSchema>

const activityTypeValues = ['created', 'fieldChange', 'statusChange', 'deleted'] as const
export const activityTypeSchema = z.enum(activityTypeValues)
export type ActivityType = z.infer<typeof activityTypeSchema>

export type Activity = {
	tenantId: string
	objectType: ActivityObjectType
	recordId: string
	createdAt: string
	id: string
	activityType: ActivityType
	actorUserId: string
	/**
	 * Super-admin who was acting as `actorUserId` at event-time, or `null` when
	 * `actorUserId` performed the action themselves. Audit-log UI must render
	 * "{actor} (impersonated by {impersonator})" whenever non-null. See
	 * Pigment Engineering 2026-04-08 pattern referenced in migration 0006.
	 */
	impersonatorUserId: string | null
	diffJson: unknown
}

/** GET /api/v1/activity?objectType=booking&recordId=book_... */
export const activityListParams = z.object({
	objectType: activityObjectTypeSchema,
	recordId: z.string().min(1).max(100),
	limit: z.coerce.number().int().min(1).max(200).optional().default(50),
})

// ActivityListParams type re-materialized via `z.infer<typeof activityListParams>`
// by the admin-UI route once wired — kept off the public surface until then.

// `fieldChange` / `statusChange` diffJson payload is documented as
// `{ field, oldValue, newValue }` — the runtime shape is enforced by the
// CDC handler `buildActivitiesFromEvent`, not by a Zod schema. When an
// admin endpoint needs to VALIDATE incoming activity bodies, re-introduce
// `activityFieldDiffSchema` here.
