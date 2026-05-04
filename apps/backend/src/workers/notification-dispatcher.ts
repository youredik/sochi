/**
 * Notification dispatcher worker — polls `notificationOutbox` for pending
 * rows, sends via the configured email adapter (Stub/Postbox), and updates
 * status / retry metadata.
 *
 * Per research synthesis 2026-04-26 (§2 outbox dispatcher pattern):
 *   - Polling, NOT CDC. Migration 0017 explicitly avoided a changefeed on
 *     `notificationOutbox` ("dispatcher consumes via separate mechanism").
 *   - 10-second poll cadence (ops-tunable via opts.pollIntervalMs).
 *   - Single-row tx, NOT batch. Postbox accepts one recipient per call.
 *   - Lock-then-send: in tx 1 bump retryCount + lastAttemptAt; HTTP send
 *     OUTSIDE tx; in tx 2 commit final status. Window between tx2 + crash
 *     can re-deliver — accepted for V1 (low frequency, transactional).
 *   - Retry classifier: permanent → status='failed' immediately; transient
 *     → exp-backoff via `nextAttemptAt`. Dead-letter at maxRetries.
 *
 * **NEVER batch the lock-and-mark step into a single multi-row UPDATE**: if
 * one row's send fails between commit and HTTP, the others get the same
 * retryCount bump but successful sends — drift between counter and reality.
 * Per-row tx is correct.
 */

import { newId } from '@horeca/shared'
import type { sql as SQL } from '../db/index.ts'
import { textOpt, timestampOpt, toJson, toTs } from '../db/ydb-helpers.ts'
import {
	computeNextAttemptAt,
	DEFAULT_RETRY_POLICY,
	type RetryPolicy,
	shouldDeadLetter,
} from './lib/dispatcher-policy.ts'
import type { EmailAdapter, EmailAttachment, SendEmailResult } from './lib/postbox-adapter.ts'
import {
	type RecipientSource,
	type ResolveResult,
	resolveRecipientEmail,
} from './lib/recipient-resolver.ts'

type SqlInstance = typeof SQL

export interface DispatcherLogger {
	debug: (obj: object, msg?: string) => void
	info: (obj: object, msg?: string) => void
	warn: (obj: object, msg?: string) => void
	error: (obj: object, msg?: string) => void
}

export interface NotificationDispatcherOptions {
	/** Polling interval in milliseconds (default 10_000). */
	pollIntervalMs?: number
	/** Max rows fetched per poll (default 100). */
	batchSize?: number
	/** From-address for the email adapter (default `'noreply@example.local'`). */
	fromAddress?: string
	/** Retry policy override (defaults to DEFAULT_RETRY_POLICY). */
	policy?: RetryPolicy
	/** Random source for jitter (default Math.random — DI for tests). */
	random?: () => number
	/** Skip starting the timer (useful in tests calling `pollOnce` directly). */
	skipTimer?: boolean
}

interface PendingRow {
	tenantId: string
	id: string
	kind: string
	channel: string
	recipient: string
	subject: string
	bodyText: string | null
	payloadJson: unknown
	/** M9.widget.5 / A3.2.b — JSON array of EmailAttachment[] (.ics + future PDF). */
	attachmentsJson: unknown
	retryCount: number | bigint
	sourceObjectType: string
	sourceObjectId: string
	sourceEventDedupKey: string
	createdAt: Date
	createdBy: string
}

const DISPATCHER_ACTOR_ID = 'system:notification_dispatcher'

/**
 * Start the dispatcher polling loop. Returns a `stop` function for graceful
 * shutdown (called from `app.ts` SIGTERM handler).
 *
 * Tests call the returned `pollOnce` directly + skip the timer entirely.
 */
export function startNotificationDispatcher(
	sql: SqlInstance,
	adapter: EmailAdapter,
	log: DispatcherLogger,
	opts: NotificationDispatcherOptions = {},
): {
	stop: () => Promise<void>
	pollOnce: () => Promise<{
		scanned: number
		sent: number
		permanent: number
		transientRetries: number
		deadLettered: number
	}>
} {
	const pollIntervalMs = opts.pollIntervalMs ?? 10_000
	const batchSize = opts.batchSize ?? 100
	const fromAddress = opts.fromAddress ?? 'noreply@example.local'
	const policy = opts.policy ?? DEFAULT_RETRY_POLICY
	const random = opts.random ?? Math.random

	let stopped = false
	let timer: NodeJS.Timeout | null = null
	let inFlight: Promise<{
		scanned: number
		sent: number
		permanent: number
		transientRetries: number
		deadLettered: number
	}> | null = null

	async function pollOnce() {
		const stats = { scanned: 0, sent: 0, permanent: 0, transientRetries: 0, deadLettered: 0 }
		const now = new Date()

		const [rows = []] = await sql<PendingRow[]>`
			SELECT tenantId, id, kind, channel, recipient, subject, bodyText,
			       payloadJson, attachmentsJson, retryCount, sourceObjectType, sourceObjectId,
			       sourceEventDedupKey, createdAt, createdBy
			FROM notificationOutbox
			WHERE status = 'pending'
			  AND retryCount < ${policy.maxRetries}
			  AND (nextAttemptAt IS NULL OR nextAttemptAt <= ${toTs(now)})
			LIMIT ${batchSize}
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)

		stats.scanned = rows.length

		for (const row of rows) {
			if (stopped) break
			try {
				const outcome = await dispatchOne(sql, adapter, log, row, fromAddress, policy, random)
				if (outcome === 'sent') stats.sent += 1
				else if (outcome === 'permanent') stats.permanent += 1
				else if (outcome === 'transient_retry') stats.transientRetries += 1
				else if (outcome === 'dead_letter') stats.deadLettered += 1
			} catch (err) {
				log.error(
					{ tenantId: row.tenantId, id: row.id, err },
					'dispatcher: unexpected error processing row — leaving pending for next cycle',
				)
			}
		}

		return stats
	}

	async function loop() {
		if (stopped) return
		try {
			inFlight = pollOnce()
			const stats = await inFlight
			if (stats.scanned > 0) {
				log.info(stats, 'dispatcher: poll cycle complete')
			}
		} catch (err) {
			log.error({ err }, 'dispatcher: poll cycle threw')
		} finally {
			inFlight = null
			if (!stopped) {
				timer = setTimeout(loop, pollIntervalMs)
			}
		}
	}

	if (!opts.skipTimer) {
		log.info({ pollIntervalMs, batchSize }, 'notification-dispatcher: started')
		// Stagger first run by a small delay so app boot isn't blocked.
		timer = setTimeout(loop, 500)
	}

	return {
		stop: async () => {
			stopped = true
			if (timer) {
				clearTimeout(timer)
				timer = null
			}
			const pending = inFlight
			if (pending !== null) await pending.catch(() => {})
			log.info({}, 'notification-dispatcher: stopped')
		},
		pollOnce,
	}
}

/* ---------------------------------------------------------------- internals */

async function dispatchOne(
	sql: SqlInstance,
	adapter: EmailAdapter,
	log: DispatcherLogger,
	row: PendingRow,
	fromAddress: string,
	policy: RetryPolicy,
	random: () => number,
): Promise<'sent' | 'permanent' | 'transient_retry' | 'dead_letter'> {
	// 1. Resolve real recipient email (M7.fix.1). The outbox row's `recipient`
	// is a placeholder ('guest@placeholder.local' or 'ops@placeholder.local')
	// because the upstream CDC writer doesn't have access to guest data.
	// Per research synthesis §9 — resolve at dispatch time, not write time
	// (guest may have changed email between booking and send).
	//
	// Ops-alert kinds (payment_failed / receipt_failed) have placeholder
	// recipient='ops@placeholder.local' — kept as-is for V1; ops resolution
	// (org owner email lookup) lands in M9 alongside Telegram bot.
	const tenantId = row.tenantId
	const id = row.id
	let recipient = row.recipient
	if (row.recipient === 'guest@placeholder.local' && isResolvableSource(row.sourceObjectType)) {
		const resolved = await resolveRecipientEmail(
			sql,
			row.sourceObjectType as RecipientSource,
			tenantId,
			row.sourceObjectId,
		)
		const next = handleResolution(resolved, log, row)
		if (next === 'fail_permanent') {
			return await markPermanent(sql, row, 'recipient unresolvable', log)
		}
		recipient = next
	}

	// 2. Render body. V1 path: `bodyText` rendered upstream by writer (or
	// dispatcher renders later via templates lib). For now, accept whatever
	// the writer pre-rendered — falling back to subject when body is empty
	// avoids sending empty mails. M7.fix.3 will switch to lazy-render via
	// notification-templates when payloadJson + kind drives it at send time.
	const subject = row.subject
	const bodyText = row.bodyText ?? row.subject
	const bodyHtml = `<p>${escapeHtmlInline(bodyText)}</p>`

	// M9.widget.5 / A3.2.b — extract attachments[] from row.attachmentsJson.
	// Schema: JSON array of `[{ filename, content (utf-8 OR base64),
	// contentType }, ...]`. NULL/empty → no attachments. Defensive parse —
	// malformed JSON / wrong shape → log + skip, don't crash dispatcher.
	const attachments = parseAttachments(row.attachmentsJson, log, row.tenantId, row.id)

	// 3. Send (single-row, no batch). Adapter classifier handles error mapping.
	const result: SendEmailResult = await adapter.send({
		from: fromAddress,
		to: recipient,
		subject,
		html: bodyHtml,
		text: bodyText,
		...(attachments && attachments.length > 0 && { attachments }),
	})

	const now = new Date()
	const newRetryCount = Number(row.retryCount) + 1

	// Per project_ydb_specifics — YDB's UPDATE rejects mixed Optional/Utf8 binds
	// in non-trivial expressions ("Expected optional, pg type or Null type, but
	// got: Utf8"). Use UPSERT with full row, mirror folio_creator pattern.
	const baseFields = {
		tenantId,
		id,
		kind: row.kind,
		channel: row.channel,
		recipient: row.recipient,
		subject: row.subject,
		bodyText: row.bodyText,
		payloadJson: row.payloadJson,
		sourceObjectType: row.sourceObjectType,
		sourceObjectId: row.sourceObjectId,
		sourceEventDedupKey: row.sourceEventDedupKey,
		createdAt: row.createdAt,
		createdBy: row.createdBy,
	}

	if (result.kind === 'sent') {
		await upsertOutbox(sql, {
			...baseFields,
			status: 'sent',
			sentAt: now,
			failedAt: null,
			failureReason: null,
			retryCount: newRetryCount,
			messageId: result.messageId,
			nextAttemptAt: null,
			updatedAt: now,
		})
		log.debug({ tenantId, id, kind: row.kind, messageId: result.messageId }, 'dispatcher: sent')
		return 'sent'
	}

	if (result.kind === 'permanent') {
		await upsertOutbox(sql, {
			...baseFields,
			status: 'failed',
			sentAt: null,
			failedAt: now,
			failureReason: truncateReason(result.reason),
			retryCount: newRetryCount,
			messageId: null,
			nextAttemptAt: null,
			updatedAt: now,
		})
		log.warn(
			{ tenantId, id, kind: row.kind, reason: result.reason },
			'dispatcher: permanent failure — dead-lettered',
		)
		return 'permanent'
	}

	// transient: bump retryCount + nextAttemptAt OR dead-letter if exhausted.
	if (shouldDeadLetter(newRetryCount, policy)) {
		await upsertOutbox(sql, {
			...baseFields,
			status: 'failed',
			sentAt: null,
			failedAt: now,
			failureReason: truncateReason(`max retries exceeded: ${result.reason}`),
			retryCount: newRetryCount,
			messageId: null,
			nextAttemptAt: null,
			updatedAt: now,
		})
		log.warn(
			{ tenantId, id, kind: row.kind, retryCount: newRetryCount, reason: result.reason },
			'dispatcher: max retries exceeded — dead-lettered',
		)
		return 'dead_letter'
	}

	const nextAttemptAt = computeNextAttemptAt(newRetryCount, now, random, policy)
	await upsertOutbox(sql, {
		...baseFields,
		status: 'pending',
		sentAt: null,
		failedAt: null,
		failureReason: truncateReason(result.reason),
		retryCount: newRetryCount,
		messageId: null,
		nextAttemptAt,
		updatedAt: now,
	})
	log.debug(
		{
			tenantId,
			id,
			kind: row.kind,
			retryCount: newRetryCount,
			nextAttemptAt: nextAttemptAt.toISOString(),
			reason: result.reason,
		},
		'dispatcher: transient — scheduled retry',
	)
	return 'transient_retry'
}

/**
 * Parse outbox row attachmentsJson → typed EmailAttachment[].
 * Defensive — malformed JSON OR wrong shape returns null (logs + skip).
 * NULL/undefined column → null (no attachments). Empty array → null.
 */
function parseAttachments(
	raw: unknown,
	log: DispatcherLogger,
	tenantId: string,
	id: string,
): EmailAttachment[] | null {
	if (raw === null || raw === undefined) return null
	const parsed = typeof raw === 'string' ? safeJsonParse(raw) : raw
	if (!Array.isArray(parsed) || parsed.length === 0) return null
	const out: EmailAttachment[] = []
	for (const item of parsed) {
		if (
			!item ||
			typeof item !== 'object' ||
			typeof (item as { filename?: unknown }).filename !== 'string' ||
			typeof (item as { content?: unknown }).content !== 'string' ||
			typeof (item as { contentType?: unknown }).contentType !== 'string'
		) {
			log.warn(
				{ tenantId, id },
				'dispatcher: malformed attachment row entry — skipping all attachments',
			)
			return null
		}
		out.push(item as EmailAttachment)
	}
	return out
}

function safeJsonParse(s: string): unknown {
	try {
		return JSON.parse(s)
	} catch {
		return null
	}
}

async function upsertOutbox(
	sql: SqlInstance,
	r: {
		tenantId: string
		id: string
		kind: string
		channel: string
		recipient: string
		subject: string
		bodyText: string | null
		payloadJson: unknown
		status: string
		sentAt: Date | null
		failedAt: Date | null
		failureReason: string | null
		retryCount: number
		messageId: string | null
		nextAttemptAt: Date | null
		sourceObjectType: string
		sourceObjectId: string
		sourceEventDedupKey: string
		createdAt: Date
		createdBy: string
		updatedAt: Date
	},
): Promise<void> {
	await sql`
		UPSERT INTO notificationOutbox (
			\`tenantId\`, \`id\`, \`kind\`, \`channel\`, \`recipient\`, \`subject\`,
			\`bodyText\`, \`payloadJson\`, \`status\`,
			\`sentAt\`, \`failedAt\`, \`failureReason\`,
			\`retryCount\`, \`messageId\`, \`nextAttemptAt\`,
			\`sourceObjectType\`, \`sourceObjectId\`, \`sourceEventDedupKey\`,
			\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
		) VALUES (
			${r.tenantId}, ${r.id}, ${r.kind}, ${r.channel}, ${r.recipient}, ${r.subject},
			${textOpt(r.bodyText)}, ${toJson(r.payloadJson)}, ${r.status},
			${timestampOpt(r.sentAt)}, ${timestampOpt(r.failedAt)}, ${textOpt(r.failureReason)},
			${r.retryCount}, ${textOpt(r.messageId)}, ${timestampOpt(r.nextAttemptAt)},
			${r.sourceObjectType}, ${r.sourceObjectId}, ${r.sourceEventDedupKey},
			${toTs(r.createdAt)}, ${toTs(r.updatedAt)}, ${r.createdBy}, ${DISPATCHER_ACTOR_ID}
		)
	`
}

function isResolvableSource(source: string): source is RecipientSource {
	return source === 'booking' || source === 'payment' || source === 'receipt'
}

/**
 * Map resolver outcome to next action: either a real email to send to, or
 * a `fail_permanent` token instructing the dispatcher to flag the row.
 */
function handleResolution(
	result: ResolveResult,
	log: DispatcherLogger,
	row: { tenantId: string; id: string; sourceObjectType: string; sourceObjectId: string },
): string | 'fail_permanent' {
	if (result.kind === 'resolved') return result.email
	log.warn(
		{
			tenantId: row.tenantId,
			id: row.id,
			source: row.sourceObjectType,
			sourceObjectId: row.sourceObjectId,
			outcome: result.kind,
			reason: result.reason,
		},
		'dispatcher: recipient resolution failed — marking permanent failure',
	)
	return 'fail_permanent'
}

async function markPermanent(
	sql: SqlInstance,
	row: PendingRow,
	reason: string,
	log: DispatcherLogger,
): Promise<'permanent'> {
	const now = new Date()
	await upsertOutbox(sql, {
		tenantId: row.tenantId,
		id: row.id,
		kind: row.kind,
		channel: row.channel,
		recipient: row.recipient,
		subject: row.subject,
		bodyText: row.bodyText,
		payloadJson: row.payloadJson,
		sourceObjectType: row.sourceObjectType,
		sourceObjectId: row.sourceObjectId,
		sourceEventDedupKey: row.sourceEventDedupKey,
		createdAt: row.createdAt,
		createdBy: row.createdBy,
		status: 'failed',
		sentAt: null,
		failedAt: now,
		failureReason: reason,
		retryCount: Number(row.retryCount) + 1,
		messageId: null,
		nextAttemptAt: null,
		updatedAt: now,
	})
	log.warn(
		{ tenantId: row.tenantId, id: row.id, reason },
		'dispatcher: marked permanent — recipient unresolvable',
	)
	return 'permanent'
}

/** Inline HTML escape duplicated from notification-templates to avoid ts cycle. */
function escapeHtmlInline(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

/** Cap reason at 500 chars to fit Utf8 column without surprise truncation. */
function truncateReason(s: string): string {
	if (s.length <= 500) return s
	return `${s.slice(0, 497)}...`
}

// Suppress unused-import lint without dropping the import statement (newId
// might be needed when M7.B.3 lands lazy-render). For now the dispatcher
// trusts upstream-rendered subject/bodyText.
void newId
