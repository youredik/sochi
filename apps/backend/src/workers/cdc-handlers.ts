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
 */
export const SYSTEM_FIELDS = new Set([
	'createdAt',
	'updatedAt',
	'createdBy',
	'updatedBy',
	// Booking state-transition timestamps — surfaced via statusChange semantic,
	// individual column deltas would just duplicate the status log.
	'confirmedAt',
	'checkedInAt',
	'checkedOutAt',
	'cancelledAt',
	'noShowAt',
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

/** Strip `id` + `tenantId` from row image → leaves domain-meaningful fields. */
function rowImage(image: Record<string, unknown>): Record<string, unknown> {
	const { id: _id, tenantId: _t, ...rest } = image
	return rest
}

/**
 * Derive activities (pure) from ONE CDC event on a booking-like row where
 * `id` + `tenantId` are top-level columns.
 *
 * Produces:
 *   INSERT → one `created` activity with `diffJson = { fields: <row> }`.
 *   UPDATE → if `status` changed, one `statusChange` + zero-N `fieldChange`
 *            for OTHER fields; else only `fieldChange` rows.
 *   DELETE → one `deleted` activity with `diffJson = { fields: <row> }`.
 */
export function buildActivitiesFromEvent(
	event: CdcEvent,
	objectType: ActivityObjectType,
): ActivityInsertInput[] {
	const isInsert = !event.oldImage && !!event.newImage
	const isDelete = !event.newImage && !!event.oldImage
	const isUpdate = !!event.oldImage && !!event.newImage

	const image = (event.newImage ?? event.oldImage) as Record<string, unknown> | undefined
	if (!image) return []

	const tenantId = String(image.tenantId ?? '')
	const recordId = String(image.id ?? '')
	if (!tenantId || !recordId) return []

	const actorUserId = String(
		(event.newImage?.updatedBy as string | undefined) ??
			(event.newImage?.createdBy as string | undefined) ??
			(event.oldImage?.updatedBy as string | undefined) ??
			'system',
	)

	const base = { tenantId, objectType, recordId, actorUserId } as const

	if (isInsert && event.newImage) {
		return [
			{
				...base,
				activityType: 'created' satisfies ActivityType,
				diffJson: { fields: rowImage(event.newImage) },
			},
		]
	}

	if (isDelete && event.oldImage) {
		return [
			{
				...base,
				activityType: 'deleted' satisfies ActivityType,
				diffJson: { fields: rowImage(event.oldImage) },
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
