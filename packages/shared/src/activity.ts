import { z } from 'zod'
import type { MemberRole } from './rbac.ts'

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
	// M10 / A7.1.fix — channel manager outbound retry log (channelDispatch table 0052).
	// CDC fan-out PMS event → N channelDispatch rows → activity_writer projects
	// each status transition (pending → sent | dlq | disabled) for admin overlay.
	'channelDispatch',
	// M10 / A7.1.fix — channel manager inbound webhook log (channelInbox table 0053).
	// Each idempotent receive surfaces as `created` activity; `tampered` replays
	// surface as `statusChange` to status='failed' for operator alerting.
	'channelInbox',
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

/**
 * GET /api/v1/activity/recent?limit=N — tenant-wide reverse-chronological feed.
 *
 * Added for the operator dashboard (A.bis.3, plan §17). Returns the most
 * recent activity rows across all objectTypes for the active tenant, ordered
 * by `createdAt DESC, id DESC` (deterministic tie-break for activities sharing
 * a ms-precision timestamp).
 *
 * Limit cap 50 chosen to match the dashboard "Recent activity" panel design:
 * 10-20 visible without scroll, 50 head-room for client-side filtering /
 * future infinite-scroll. Higher limits would scan more of the tenant's
 * activity partition than is useful at the SMB volumes this dashboard targets.
 */
export const activityRecentParams = z.object({
	limit: z.coerce.number().int().min(1).max(50).optional().default(20),
})

/**
 * Per-role allow-list of ActivityObjectType values that the role MAY see in
 * the operator dashboard's «Recent activity» feed.
 *
 * **Why a function, not a static map** (A.bis.5 fix-up — bug A3.1 from senior
 * bug hunt 2026-05-12): `/activity/recent` is reached by all 3 roles
 * (owner / manager / staff) because the dashboard surface is universal, but
 * staff lacks `notification:read` / `refund:read` / `report:read` (the latter
 * is the channel-manager gate). The endpoint must NOT surface activity
 * entries for objectTypes the role can't access by URL — otherwise staff
 * reads a one-line summary of every notification dispatch / refund attempt /
 * channel sync via the dashboard even though the underlying detail pages
 * 403 them. Mirror of the resource-level RBAC matrix in `rbac.ts`.
 *
 * Mapping rationale (each ObjectType → the rbac.ts resource that gates its
 * detail surface):
 *   - booking / property / roomType / room / ratePlan / availability / rate
 *     → booking / property / room / ratePlan (all 3 roles read)
 *   - guest / folio / payment / receipt → all 3 roles read
 *   - migrationRegistration → all 3 roles read (rbac.ts:116)
 *   - refund / dispute → manager+ (refund:read; staff lacks)
 *   - notification → manager+ (notification:read; staff lacks per rbac.ts:107)
 *   - channelDispatch / channelInbox → manager+ (gated by report:read like
 *     the /admin/channels page; staff lacks report:read)
 *
 * Used by `/activity/recent` route handler to post-filter the repo response
 * by `c.var.memberRole`. Kept in `shared` (not in `apps/backend`) so the
 * frontend can also pre-filter if a future use-case fetches the raw feed
 * client-side.
 */

const STAFF_DENIED_ACTIVITY_TYPES = new Set<ActivityObjectType>([
	'refund',
	'dispute',
	'notification',
	'channelDispatch',
	'channelInbox',
])

export function roleCanReadActivityObject(
	role: MemberRole,
	objectType: ActivityObjectType,
): boolean {
	if (role === 'owner' || role === 'manager') return true
	// role === 'staff'
	return !STAFF_DENIED_ACTIVITY_TYPES.has(objectType)
}

export function filterActivitiesByRole<T extends { objectType: ActivityObjectType }>(
	items: readonly T[],
	role: MemberRole,
): T[] {
	return items.filter((a) => roleCanReadActivityObject(role, a.objectType))
}

// `fieldChange` / `statusChange` diffJson payload is documented as
// `{ field, oldValue, newValue }` — the runtime shape is enforced by the
// CDC handler `buildActivitiesFromEvent`, not by a Zod schema. When an
// admin endpoint needs to VALIDATE incoming activity bodies, re-introduce
// `activityFieldDiffSchema` here.
