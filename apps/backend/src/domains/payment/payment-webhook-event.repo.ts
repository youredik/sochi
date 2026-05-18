/**
 * paymentWebhookEvent repo — inbox table для inbound webhooks (canon
 * `project_payment_domain_canonical.md` §0010_payment_webhook_event.sql).
 *
 * PK 3D: `(tenantId, providerCode, dedupKey)`. Duplicate redelivery hits PK
 * collision (YDB 400120) → translated к `WebhookAlreadyProcessedError` per
 * canonical pattern (M6.2/M6.3). 30-day TTL on `verifiedAt`.
 *
 * NO CHANGEFEED — это inbox sink, downstream effects (state transitions)
 * emit their own events via payment_events / refund_events changefeeds.
 */

import type { PaymentProviderCode, PaymentWebhookEvent } from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'

type SqlInstance = typeof SQL

export type PaymentWebhookEventInsertInput = {
	tenantId: string
	providerCode: PaymentProviderCode
	dedupKey: string
	eventType: string
	providerPaymentId: string | null
	providerRefundId: string | null
	payloadJson: unknown
	signatureHeader: string | null
	sourceIp: string | null
}

export type PaymentWebhookEventInsertResult =
	| { kind: 'inserted'; event: PaymentWebhookEvent }
	| { kind: 'duplicate'; existing: PaymentWebhookEvent }

type PaymentWebhookEventDbRow = {
	tenantId: string
	providerCode: string
	dedupKey: string
	eventType: string
	providerPaymentId: string | null
	providerRefundId: string | null
	payloadJson: string | object
	signatureHeader: string | null
	sourceIp: string | null
	verifiedAt: string
	processedAt: string | null
	processingError: string | null
	processedBy: string | null
}

function rowToEvent(r: PaymentWebhookEventDbRow): PaymentWebhookEvent {
	return {
		tenantId: r.tenantId,
		providerCode: r.providerCode,
		dedupKey: r.dedupKey,
		eventType: r.eventType,
		providerPaymentId: r.providerPaymentId,
		providerRefundId: r.providerRefundId,
		payloadJson: typeof r.payloadJson === 'string' ? JSON.parse(r.payloadJson) : r.payloadJson,
		signatureHeader: r.signatureHeader,
		sourceIp: r.sourceIp,
		verifiedAt: r.verifiedAt,
		processedAt: r.processedAt,
		processingError: r.processingError,
		processedBy: r.processedBy,
	}
}

/** YDB `PRECONDITION_FAILED` UNIQUE/PK collision code (canon M6.2/M6.3). */
const YDB_PK_COLLISION_CODE = 400120

function isYdbPkCollision(err: unknown): boolean {
	if (err instanceof Error && err.cause !== undefined) {
		const cause = err.cause as { code?: unknown }
		if (cause.code === YDB_PK_COLLISION_CODE) return true
	}
	return false
}

export function createPaymentWebhookEventRepo(sql: SqlInstance) {
	return {
		/**
		 * Insert a verified webhook envelope. PK collision on
		 * `(tenantId, providerCode, dedupKey)` → returns `kind:'duplicate'` after
		 * loading the existing row (idempotent replay). Other errors propagate.
		 */
		async insertOrSkip(
			input: PaymentWebhookEventInsertInput,
		): Promise<PaymentWebhookEventInsertResult> {
			const verifiedAt = new Date()
			const payloadJsonText = JSON.stringify(input.payloadJson ?? null)

			try {
				await sql.begin({ idempotent: true }, async (tx) => {
					await tx<unknown[]>`
						UPSERT INTO paymentWebhookEvent (
							tenantId, providerCode, dedupKey,
							eventType, providerPaymentId, providerRefundId,
							payloadJson, signatureHeader, sourceIp,
							verifiedAt
						) VALUES (
							${input.tenantId}, ${input.providerCode}, ${input.dedupKey},
							${input.eventType}, ${input.providerPaymentId}, ${input.providerRefundId},
							CAST(${payloadJsonText} AS Json), ${input.signatureHeader}, ${input.sourceIp},
							${verifiedAt}
						)
					`
				})
			} catch (err) {
				if (isYdbPkCollision(err)) {
					const existing = await this.findByDedupKey(
						input.tenantId,
						input.providerCode,
						input.dedupKey,
					)
					if (existing === null) {
						throw new Error(
							`paymentWebhookEvent: PK collision but row not found — race window? tenant=${input.tenantId} dedup=${input.dedupKey}`,
						)
					}
					return { kind: 'duplicate', existing }
				}
				throw err
			}

			const inserted = await this.findByDedupKey(input.tenantId, input.providerCode, input.dedupKey)
			if (inserted === null) {
				throw new Error(
					`paymentWebhookEvent: insert succeeded but row not retrievable — replication lag? tenant=${input.tenantId} dedup=${input.dedupKey}`,
				)
			}
			return { kind: 'inserted', event: inserted }
		},

		async findByDedupKey(
			tenantId: string,
			providerCode: PaymentProviderCode,
			dedupKey: string,
		): Promise<PaymentWebhookEvent | null> {
			const rows = await sql<PaymentWebhookEventDbRow[]>`
				SELECT
					tenantId, providerCode, dedupKey,
					eventType, providerPaymentId, providerRefundId,
					payloadJson, signatureHeader, sourceIp,
					verifiedAt, processedAt, processingError, processedBy
				FROM paymentWebhookEvent
				WHERE tenantId = ${tenantId}
				  AND providerCode = ${providerCode}
				  AND dedupKey = ${dedupKey}
			`
			const row = rows[0]?.[0]
			return row === undefined ? null : rowToEvent(row)
		},

		/**
		 * Mark webhook event as processed (after downstream transition succeeded).
		 * Idempotent — re-marking is a no-op.
		 */
		async markProcessed(
			tenantId: string,
			providerCode: PaymentProviderCode,
			dedupKey: string,
			processedBy: string,
		): Promise<void> {
			const processedAt = new Date()
			await sql.begin({ idempotent: true }, async (tx) => {
				await tx<unknown[]>`
					UPDATE paymentWebhookEvent
					SET processedAt = ${processedAt}, processedBy = ${processedBy}, processingError = NULL
					WHERE tenantId = ${tenantId}
					  AND providerCode = ${providerCode}
					  AND dedupKey = ${dedupKey}
				`
			})
		},

		/** Record processing failure for retry surface / audit. */
		async markFailed(
			tenantId: string,
			providerCode: PaymentProviderCode,
			dedupKey: string,
			error: string,
		): Promise<void> {
			await sql.begin({ idempotent: true }, async (tx) => {
				await tx<unknown[]>`
					UPDATE paymentWebhookEvent
					SET processingError = ${error.slice(0, 1024)}
					WHERE tenantId = ${tenantId}
					  AND providerCode = ${providerCode}
					  AND dedupKey = ${dedupKey}
				`
			})
		},
	}
}

export type PaymentWebhookEventRepo = ReturnType<typeof createPaymentWebhookEventRepo>
