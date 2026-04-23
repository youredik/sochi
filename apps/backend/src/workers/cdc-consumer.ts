import type { Activity, ActivityObjectType } from '@horeca/shared'
import type { Driver } from '@ydbjs/core'
import { createTopicReader } from '@ydbjs/topic/reader'
import type { ActivityRepo } from '../domains/activity/activity.repo.ts'
import { logger } from '../logger.ts'
import { buildActivitiesFromEvent, type CdcEvent } from './cdc-handlers.ts'

interface ConsumerConfig {
	/** Topic path — for table changefeeds, typically `<table>/<changefeedName>`. */
	topic: string
	/** Consumer name registered on the topic (see migration where ADD CONSUMER runs). */
	consumer: string
	/** Side-effect called with each parsed CDC event. MUST not throw or the consumer halts. */
	handler: (event: CdcEvent) => Promise<unknown>
	/** Human-readable label for logs. */
	label: string
}

/**
 * Long-running CDC consumer — reads a YDB topic changefeed, parses each
 * message as a CDC event, and invokes the handler.
 *
 * Reconnection / retry is handled INTERNALLY by @ydbjs/topic 6.1.x via its
 * `defaultStreamRetryConfig` (budget: Infinity, exponential backoff) — the
 * for-await loop is oblivious to stream drops. Non-retryable errors (auth,
 * topic not found) surface here and terminate the consumer.
 *
 * `waitMs: 5_000` — yields an empty batch every 5s so the `stopped` flag
 * check runs even when the topic is idle.
 *
 * Returns `{ stop }`: call before process exit for a graceful drain
 * (reader.close() waits up to 30s for pending commits).
 */
export function startCdcConsumer(driver: Driver, config: ConsumerConfig) {
	let stopped = false
	const reader = createTopicReader(driver, {
		topic: config.topic,
		consumer: config.consumer,
	})

	async function loop() {
		logger.info(
			{ topic: config.topic, consumer: config.consumer },
			`cdc-consumer started: ${config.label}`,
		)
		try {
			for await (const batch of reader.read({ waitMs: 5_000 })) {
				if (stopped) break
				for (const msg of batch) {
					try {
						const payload = new TextDecoder().decode(msg.payload)
						const event = JSON.parse(payload) as CdcEvent
						await config.handler(event)
					} catch (err) {
						logger.error(
							{ err, topic: config.topic, consumer: config.consumer },
							`cdc-consumer ${config.label}: failed to process event — continuing`,
						)
					}
				}
				if (batch.length > 0) await reader.commit(batch)
			}
		} catch (err) {
			if (!stopped) {
				logger.error(
					{ err, topic: config.topic, consumer: config.consumer },
					`cdc-consumer ${config.label}: fatal non-retryable error`,
				)
			}
		}
	}

	loop().catch((err) =>
		logger.error({ err, label: config.label }, 'cdc-consumer: unhandled loop error'),
	)

	return {
		stop: async () => {
			stopped = true
			await reader.close()
		},
	}
}

/**
 * Build a side-effect handler that persists derived activities via the repo.
 * Failures on individual inserts are logged and SKIPPED — a broken handler
 * MUST NOT block the consumer loop. True DLQ is Phase 3.
 */
export function createActivityCdcHandler(repo: ActivityRepo, objectType: ActivityObjectType) {
	return async (event: CdcEvent): Promise<Activity[]> => {
		const activities = buildActivitiesFromEvent(event, objectType)
		const inserted: Activity[] = []
		for (const input of activities) {
			try {
				inserted.push(await repo.insert(input))
			} catch (err) {
				logger.error(
					{
						err,
						objectType,
						recordId: input.recordId,
						tenantId: input.tenantId,
						activityType: input.activityType,
					},
					'cdc-consumer: activity INSERT failed — continuing (no DLQ на старте)',
				)
			}
		}
		return inserted
	}
}
