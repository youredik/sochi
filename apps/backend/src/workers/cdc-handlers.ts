import type { ActivityObjectType, ActivityType } from '@horeca/shared'
import type { ActivityInsertInput } from '../domains/activity/activity.repo.ts'

/**
 * YDB CDC event shape — NEW_AND_OLD_IMAGES + JSON format, verified 2026
 * against https://ydb.tech/docs/en/concepts/cdc (v25.3).
 *
 * Per-mode presence:
 *   INSERT: `key`, `update`, `newImage`; `oldImage` absent.
 *   UPDATE: `key`, `update`, `newImage`, `oldImage` — both snapshots.
 *   DELETE: `key`, `erase: {}`, `oldImage`; `newImage` absent.
 * With VIRTUAL_TIMESTAMPS=TRUE → extra `ts: [step, txId]` field.
 */
export interface CdcEvent {
	key: unknown[]
	update?: Record<string, unknown>
	reset?: Record<string, unknown>
	erase?: Record<string, unknown>
	newImage?: Record<string, unknown>
	oldImage?: Record<string, unknown>
	ts?: [number, number]
}

/**
 * Columns that should NOT generate `fieldChange` activities — they're either
 * server-populated audit metadata (captured elsewhere) or derivable from
 * state-transition timestamps (`checkedInAt`/`cancelledAt`/… → statusChange).
 *
 * The state-transition timestamps come from EVERY domain that has an FSM
 * (booking + payment + refund + folio + folioLine + receipt + dispute).
 * Listing them here de-duplicates the audit signal: when the FSM advances,
 * we emit ONE `statusChange` activity from the `status` column delta —
 * individual `confirmedAt`/`succeededAt`/etc deltas are the SAME event
 * recorded twice and would clutter the audit log.
 */
export const SYSTEM_FIELDS = new Set([
	'createdAt',
	'updatedAt',
	'createdBy',
	'updatedBy',
	// Booking state-transition timestamps
	'confirmedAt',
	'checkedInAt',
	'checkedOutAt',
	'cancelledAt',
	'noShowAt',
	// Payment FSM timestamps (canon: 9-state)
	'authorizedAt',
	'capturedAt',
	'refundedAt',
	'canceledAt',
	'failedAt',
	'expiredAt',
	// Refund FSM timestamps (canon: 3-state)
	'requestedAt',
	'succeededAt',
	// Folio FSM timestamps (canon: 3-state)
	'closedAt',
	'settledAt',
	// folioLine sub-state timestamps (canon: 3-state)
	'postedAt',
	'voidedAt',
	// Receipt FSM timestamps (canon: 5-state)
	'sentAt',
	'correctedAt',
	// Dispute FSM timestamps (canon: 5-state)
	'submittedAt',
	'resolvedAt',
])

/** Shallow equality matching stankoff-v2 / records.service — stringified compare
 * avoids false-positive deltas on Date|number round-trips through JSON. */
function valuesEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (a == null && b == null) return true
	return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Pure diff — returns one `{field, oldValue, newValue}` entry per changed
 * non-system column. Caller is responsible for the write side (one activity
 * row per entry).
 */
export function diffFields(
	oldImage: Record<string, unknown>,
	newImage: Record<string, unknown>,
	skip: ReadonlySet<string> = SYSTEM_FIELDS,
): Array<{ field: string; oldValue: unknown; newValue: unknown }> {
	const out: Array<{ field: string; oldValue: unknown; newValue: unknown }> = []
	// Union of keys — a field present only in one image counts as changed
	// (covers schema drift / newly-added columns on UPSERT overwrites).
	const allKeys = new Set([...Object.keys(oldImage), ...Object.keys(newImage)])
	for (const field of allKeys) {
		if (skip.has(field)) continue
		const oldValue = oldImage[field]
		const newValue = newImage[field]
		if (valuesEqual(oldValue, newValue)) continue
		out.push({ field, oldValue, newValue })
	}
	return out
}

/**
 * Derive activities (pure) from ONE CDC event.
 *
 * YDB CDC contract (verified 2026-04 from ydb.tech/docs/en/concepts/cdc):
 *   > "JSON object fields containing column names and values (newImage,
 *   > oldImage, and update & reset in UPDATES mode), do not include the
 *   > columns that are primary key components."
 *
 * So we extract identity from `event.key[]` — NOT from newImage/oldImage —
 * then diff the image bodies for fieldChange/statusChange events.
 *
 * Produces:
 *   INSERT → one `created` activity with `diffJson = { fields: <newImage> }`.
 *   UPDATE → if `status` changed, one `statusChange` + zero-N `fieldChange`
 *            for OTHER fields; else only `fieldChange` rows.
 *   DELETE → one `deleted` activity with `diffJson = { fields: <oldImage> }`.
 *
 * Per-objectType PK schema (matches migrations 0001/0007/0008/0009/0011/0012):
 *   - 4D PK `(tenantId, propertyId, _, id)`: booking, folio, payment
 *     → key[0]=tenantId, key[3]=id
 *   - 3D PK `(tenantId, paymentId, id)`: refund, receipt, dispute
 *     → key[0]=tenantId, key[2]=id
 *   - 2D PK `(tenantId, id)`: single-PK domains (default fallback)
 *     → key[0]=tenantId, key[1]=id
 */
const FOUR_D_PK_DOMAINS: ReadonlySet<ActivityObjectType> = new Set(['booking', 'folio', 'payment'])
const THREE_D_PK_DOMAINS: ReadonlySet<ActivityObjectType> = new Set([
	'refund',
	'receipt',
	'dispute',
])

function extractIdentity(
	event: CdcEvent,
	objectType: ActivityObjectType,
): { tenantId: string; recordId: string } | null {
	const key = event.key ?? []
	const tenantId = key[0] === undefined ? '' : String(key[0])
	let recordId = ''
	if (FOUR_D_PK_DOMAINS.has(objectType)) {
		recordId = key[3] === undefined ? '' : String(key[3])
	} else if (THREE_D_PK_DOMAINS.has(objectType)) {
		recordId = key[2] === undefined ? '' : String(key[2])
	} else {
		// Single-PK domains: `(tenantId, id)` → key[0]=tenantId, key[1]=id.
		recordId = key[1] === undefined ? '' : String(key[1])
	}
	if (!tenantId || !recordId) return null
	return { tenantId, recordId }
}

export function buildActivitiesFromEvent(
	event: CdcEvent,
	objectType: ActivityObjectType,
): ActivityInsertInput[] {
	const isInsert = !event.oldImage && !!event.newImage
	const isDelete = !event.newImage && !!event.oldImage
	const isUpdate = !!event.oldImage && !!event.newImage

	const identity = extractIdentity(event, objectType)
	if (!identity) return []
	const { tenantId, recordId } = identity

	const actorUserId = String(
		(event.newImage?.updatedBy as string | undefined) ??
			(event.newImage?.createdBy as string | undefined) ??
			(event.oldImage?.updatedBy as string | undefined) ??
			'system',
	)

	// Derive actorType from the actorUserId convention. System workers
	// (cron / CDC / dispatcher) prefix with `system:`; real users are typed
	// IDs `usr_...`. Public-widget guests will set actorType='guest'
	// explicitly via M8.B.
	const actorType: 'system' | 'user' =
		actorUserId === 'system' || actorUserId.startsWith('system:') ? 'system' : 'user'

	const base = { tenantId, objectType, recordId, actorUserId, actorType } as const

	if (isInsert && event.newImage) {
		return [
			{
				...base,
				activityType: 'created' satisfies ActivityType,
				diffJson: { fields: event.newImage },
			},
		]
	}

	if (isDelete && event.oldImage) {
		return [
			{
				...base,
				activityType: 'deleted' satisfies ActivityType,
				diffJson: { fields: event.oldImage },
			},
		]
	}

	if (isUpdate && event.oldImage && event.newImage) {
		const diffs = diffFields(event.oldImage, event.newImage)
		if (diffs.length === 0) return []

		const statusDiff = diffs.find((d) => d.field === 'status')
		const fieldDiffs = diffs.filter((d) => d.field !== 'status')

		const out: ActivityInsertInput[] = []
		if (statusDiff) {
			out.push({
				...base,
				activityType: 'statusChange' satisfies ActivityType,
				diffJson: {
					field: 'status',
					oldValue: statusDiff.oldValue,
					newValue: statusDiff.newValue,
				},
			})
		}
		for (const d of fieldDiffs) {
			out.push({
				...base,
				activityType: 'fieldChange' satisfies ActivityType,
				diffJson: { field: d.field, oldValue: d.oldValue, newValue: d.newValue },
			})
		}
		return out
	}

	return []
}

// The side-effect handler that persists derived activities lives alongside
// the consumer loop in `cdc-consumer.ts` — this module stays pure so unit
// tests don't pull in env.ts / logger.ts (which call process.exit on missing
// env and blow up vitest before any test runs).
