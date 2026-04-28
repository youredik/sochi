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
	// M7.fix.3.c — operator manual actions on notification outbox
	'notification',
	// M8.A.5.cdc.B — миграционный учёт МВД (Боль 1.1). FSM transitions
	// 0 → 17 → 3/4/10 проектируются в activity для audit + operator UI.
	'migrationRegistration',
] as const
export const activityObjectTypeSchema = z.enum(activityObjectTypeValues)
export type ActivityObjectType = z.infer<typeof activityObjectTypeSchema>

const activityTypeValues = [
	'created',
	'fieldChange',
	'statusChange',
	'deleted',
	// M7.fix.3.c — operator-triggered retry of failed/stuck outbox row
	'manualRetry',
] as const
export const activityTypeSchema = z.enum(activityTypeValues)
export type ActivityType = z.infer<typeof activityTypeSchema>

/**
 * Who performed the audited action — symmetric to
 * `NotificationRecipientKind`. Plan v2 §7.1 #7. Stored on
 * `activity.actorType`; nullable for M7-era rows (read code falls back
 * to `user` per backwards-compat semantics).
 *
 *   - `user`    — internal operator/staff
 *   - `guest`   — public-widget customer (M8.B+)
 *   - `system`  — automated workflow (CDC consumer, cron, retry handler)
 *   - `channel` — channel-manager / OTA push (M8.C+)
 */
const activityActorTypeValues = ['user', 'guest', 'system', 'channel'] as const
export const activityActorTypeSchema = z.enum(activityActorTypeValues)
export type ActivityActorType = z.infer<typeof activityActorTypeSchema>

export type Activity = {
	tenantId: string
	objectType: ActivityObjectType
	recordId: string
	createdAt: string
	id: string
	activityType: ActivityType
	/**
	 * Routing dimension for audit UI filters and downstream alerting.
	 * Nullable for legacy M7 rows; UI MUST treat null as `user`.
	 */
	actorType: ActivityActorType | null
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
