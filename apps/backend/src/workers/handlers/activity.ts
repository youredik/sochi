/**
 * `activity_writer` CDC handler — populates the polymorphic `activity`
 * audit log by diffing oldImage/newImage of every domain table that has
 * a CHANGEFEED.
 *
 * Domain semantics (canon `project_event_architecture.md`):
 *   - One handler factory bound at construction to a specific `objectType`
 *     (booking | folio | payment | refund | receipt | dispute | ...).
 *   - Pure CDC projection — NO business code path inserts into `activity`
 *     directly. This factory is the SOLE writer.
 *   - Inserts via `repo.insertTx(tx, ..., dedupKey)` with a deterministic
 *     `dedupKey` derived from the CDC event's virtual timestamp tuple +
 *     activity index. The repo runs a SELECT-then-INSERT pre-check
 *     against `ixActivityDedup` (migration 0018) so a redelivered event
 *     produces ZERO duplicate audit rows.
 *
 * ## Idempotency design (canon: at-least-once + idempotent)
 *
 * The CDC consumer pivoted from `createTopicTxReader` (broken under N>1
 * concurrent consumers, see `cdc-consumer.ts` header) to non-tx
 * `createTopicReader` + manual `reader.commit(batch)` after the projection
 * tx commits. That introduces an at-least-once race: if commit succeeds
 * but `reader.commit(batch)` fails, the batch redelivers and the projection
 * runs again.
 *
 * For activity audit, `id = newId()` random, so re-running INSERT would
 * create a duplicate row. The `dedupKey` (CDC virtual timestamp + index)
 * is deterministic and lets the repo short-circuit duplicate inserts.
 *
 * Per-event semantics: any insert failure throws — caller's tx rolls
 * back and the batch redelivers. Activity inserts rarely fail once schema
 * is in place; transient YDB errors that DO happen are the exact case
 * we WANT redelivered.
 */
import type { Activity, ActivityObjectType } from '@horeca/shared'
import type { TX } from '@ydbjs/query'
import type { ActivityRepo } from '../../domains/activity/activity.repo.ts'
import { buildActivitiesFromEvent, type CdcEvent } from '../cdc-handlers.ts'

/**
 * Build a deterministic dedup key per derived activity row from the CDC
 * event's virtual timestamp tuple. Returns `null` if the event lacks the
 * `ts` field (would only happen if `VIRTUAL_TIMESTAMPS = TRUE` was not
 * set on the changefeed; all M6 changefeeds set it — defensive fallback).
 *
 * Shape: `${step}-${txId}-${index}` where `step/txId` are unique per CDC
 * event in YDB and `index` distinguishes multiple activity rows derived
 * from the same event (1 statusChange + N fieldChange).
 */
function buildActivityDedupKey(event: CdcEvent, index: number): string | null {
	if (!event.ts || event.ts.length < 2) return null
	const [step, txId] = event.ts
	return `${step}-${txId}-${index}`
}

/**
 * Build a CDC projection for the polymorphic `activity` audit log.
 *
 * No `HandlerLogger` dependency — activity inserts don't have a
 * decision branch that would need a debug/info trace; failure modes
 * surface as thrown errors caught at the cdc-consumer loop level.
 */
export function createActivityCdcHandler(repo: ActivityRepo, objectType: ActivityObjectType) {
	return async (tx: TX, event: CdcEvent): Promise<Activity[]> => {
		const inputs = buildActivitiesFromEvent(event, objectType)
		const inserted: Activity[] = []
		for (let i = 0; i < inputs.length; i++) {
			const input = inputs[i]
			if (!input) continue
			const dedupKey = buildActivityDedupKey(event, i)
			inserted.push(await repo.insertTx(tx, input, dedupKey))
		}
		return inserted
	}
}
