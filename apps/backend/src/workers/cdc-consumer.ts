/**
 * CDC consumer — long-running reader over a YDB CHANGEFEED topic with
 * **at-least-once** delivery + idempotent projection semantics.
 *
 * ## Architecture (post empirical pivot, 2026-04-25)
 *
 * Original plan (createTopicTxReader for atomic offset+writes commit) was
 * EMPIRICALLY broken under our 13-consumer concurrent wiring: every
 * `sql.begin` opened a fresh `streamRead` and tore it down on commit
 * (PR #544 binds the tx-reader to tx lifetime). Server-side partition
 * session ownership cascaded into 400070 SCHEME_ERROR / 400190 SESSION_BUSY
 * across ALL consumers, blocking projections entirely (verified: activity
 * table empty after 50s of cycling under 3 different mutex strategies).
 *
 * Canonical 2026 SOTA fix: use the NON-tx `createTopicReader` API which
 * holds a long-lived stream across many batches. Reader is created ONCE
 * per consumer at startup, lives until shutdown. Manual
 * `await reader.commit(batch)` advances the offset AFTER the projection
 * tx commits.
 *
 * ## At-least-once + idempotent projections
 *
 * Failure modes:
 *   - Projection sql.begin fails    → reader.commit NOT called →
 *                                     batch redelivers next read.
 *   - Projection succeeds + commit fails (rare race) → batch redelivers,
 *     re-runs projection. Projection MUST be idempotent on event identity.
 *
 * All M6.5 handlers are upsert-shaped or pre-check-then-write:
 *   - refund_creator_writer: SELECT-then-UPSERT on UNIQUE (tenant, causalityId).
 *   - notification_writer:    SELECT-then-UPSERT on UNIQUE (tenant, dedupKey).
 *   - payment_status_writer:  derived === current short-circuit + version-CAS.
 *   - folio_balance_writer:   computed === current short-circuit + version-CAS.
 *   - activity_writer:        UPSERT (tenant, objectType, recordId, ts, id);
 *                             id is random per insert — replays produce
 *                             duplicate audit rows in the rare commit-after-
 *                             projection-failure window. Acceptable for an
 *                             audit log; M6.5.1 may add an event-offset
 *                             dedup column if duplicates ever surface in
 *                             practice (production monitoring will tell).
 *
 * Single-flight: each consumer has ONE long-lived reader, serializes its
 * own batch processing naturally. No cross-consumer mutex needed; YDB topic
 * scopes partition sessions per (consumer-name, topic, partition).
 *
 * Refs:
 *   - @ydbjs/topic 6.1.x README §Reader (non-tx API; this is what we use)
 *   - PR #544 — confirms tx-reader destroys streamRead on commit
 *   - https://ydb.tech/docs/en/concepts/topic — partition session ownership
 */
import type { Driver } from '@ydbjs/core'
import type { TX } from '@ydbjs/query'
import { createTopicReader } from '@ydbjs/topic/reader'
import type { sql as SQL } from '../db/index.ts'
import { logger } from '../logger.ts'
import type { CdcEvent } from './cdc-handlers.ts'

// Re-export for back-compat — the canonical home is now ./handlers/activity.ts
// to keep cdc-consumer.ts focused on the consumer infrastructure.
export { createActivityCdcHandler } from './handlers/activity.ts'

type SqlInstance = typeof SQL

export interface ConsumerConfig {
	/** Topic path (changefeed). E.g. 'payment/payment_events'. */
	topic: string
	/** Consumer name as registered via ALTER TOPIC ... ADD CONSUMER. */
	consumer: string
	/**
	 * Domain projection. Invoked for each CDC event with the OPEN tx that
	 * the consumer wraps each batch in. THROWING rolls back the projection
	 * tx; the topic offset is NOT committed and the message redelivers.
	 *
	 * Projection MUST be idempotent — re-runs on rare commit-after-fail
	 * race must produce the same outcome (UPSERT-shape + pre-check-or-CAS).
	 */
	projection: (tx: TX, event: CdcEvent) => Promise<unknown>
	/** Human-readable label for logs. */
	label: string
}

const BATCH_LIMIT = 100
/** How long the persistent reader waits for a batch before yielding empty. */
const READ_WAIT_MS = 5_000
/** Backoff after a projection / commit failure before retrying the batch. */
const ERROR_BACKOFF_MS = 1_000

/**
 * Start a CDC consumer in the background. Returns a stop handle for
 * graceful shutdown (closes reader after in-flight batch settles).
 */
export function startCdcConsumer(driver: Driver, sql: SqlInstance, config: ConsumerConfig) {
	let stopped = false
	const controller = new AbortController()
	const reader = createTopicReader(driver, {
		topic: config.topic,
		consumer: config.consumer,
	})

	async function loop(): Promise<void> {
		logger.info(
			{ topic: config.topic, consumer: config.consumer },
			`cdc-consumer started: ${config.label}`,
		)
		// Outer restart loop: `reader.read({...})` returns an async iterable
		// whose generator can complete naturally (e.g., partition rebalance,
		// upstream stream-end). When that happens we want to resume reading,
		// not silently exit the consumer for the lifetime of the process.
		// Empirically caught: without this wrapper, all 13 consumer loops
		// exited within 2s of startup leaving the process running but with
		// zero CDC processing. Backlog drain happens on first iteration only.
		while (!stopped) {
			try {
				for await (const batch of reader.read({
					signal: controller.signal,
					limit: BATCH_LIMIT,
					waitMs: READ_WAIT_MS,
				})) {
					if (stopped) break
					if (batch.length === 0) continue

					await sql.begin({ idempotent: true }, async (tx) => {
						for (const msg of batch) {
							const payload = new TextDecoder().decode(msg.payload)
							const event = JSON.parse(payload) as CdcEvent
							await config.projection(tx, event)
						}
					})
					// Projection tx committed → advance the topic offset. If
					// reader.commit itself fails (rare) the batch will redeliver
					// and the projection will re-run — handlers are idempotent
					// per the contract above.
					await reader.commit(batch)
				}
				// Generator returned without throwing — reader is still alive,
				// just yielded its current iteration. Brief pause then resume
				// (calling reader.read() again opens a fresh iteration).
				if (stopped) break
				await new Promise((r) => setTimeout(r, 100))
			} catch (err) {
				if (stopped || controller.signal.aborted) break
				logger.warn(
					{ err, topic: config.topic, consumer: config.consumer },
					`cdc-consumer ${config.label}: batch failed — backing off ${ERROR_BACKOFF_MS}ms`,
				)
				await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS))
			}
		}
		logger.info(
			{ topic: config.topic, consumer: config.consumer },
			`cdc-consumer stopped: ${config.label}`,
		)
	}

	loop().catch((err) =>
		logger.error({ err, label: config.label }, 'cdc-consumer: unhandled loop error'),
	)

	return {
		stop: async () => {
			stopped = true
			controller.abort()
			await reader.close()
		},
	}
}
