/**
 * Channel dispatch repo — M10 / A7.1.fix.
 *
 * CRUD над `channelDispatch` (migration 0052) — outbound retry state per
 * D14.b (R3b verdict). CDC consumer fans out → INSERT one row per active
 * channel; dispatcher worker (`workers/channel-dispatcher.ts`) claims pending
 * rows, attempts HTTP, and updates retry state.
 *
 * Atomic claim semantics:
 *   - YDB has no `SELECT FOR UPDATE`; we wrap claim в `sql.begin` Serializable tx.
 *   - SELECT pending rows WHERE nextAttemptAt ≤ now LIMIT N
 *   - UPDATE each row's nextAttemptAt += leaseMs (so concurrent claimers see them
 *     as «not yet due»). On retry result, dispatcher overwrites nextAttemptAt
 *     with the canonical schedule.
 *   - Tx aborts → no rows claimed (caller retries).
 *
 * Cross-tenant guard: every method except `claimDueBatch` (poller — global)
 * filters by tenantId. `claimDueBatch` is multi-tenant by design; the worker
 * delegates to per-tenant adapter resolution downstream.
 */

import { randomUUID } from 'node:crypto'
import type { sql as SQL } from '../../db/index.ts'
import { NULL_INT32, toJson } from '../../db/ydb-helpers.ts'
import type { DispatchStatus } from '../../lib/channel-manager/channel-dispatch.ts'

type SqlInstance = typeof SQL

export interface ChannelDispatchEnqueue {
	readonly tenantId: string
	readonly channelId: string
	readonly eventSource: string
	readonly eventId: string
	readonly eventType: string
	readonly idempotencyKey: string
	readonly payload: unknown
	/** Initial scheduled-at; default = now (immediate dispatch). */
	readonly nextAttemptAtMs?: number
}

export interface ChannelDispatchRow {
	readonly tenantId: string
	readonly dispatchId: string
	readonly channelId: string
	readonly eventSource: string
	readonly eventId: string
	readonly eventType: string
	readonly idempotencyKey: string
	readonly payload: unknown
	readonly attemptCount: number
	readonly lastHttpStatus: number | null
	readonly lastErrorJson: unknown
	readonly nextAttemptAt: string
	readonly status: DispatchStatus
	readonly createdAt: string
	readonly updatedAt: string
}

type DispatchYdbRow = {
	tenantId: string
	dispatchId: string
	channelId: string
	eventSource: string
	eventId: string
	eventType: string
	idempotencyKey: string
	payloadJson: unknown
	attemptCount: number | bigint
	lastHttpStatus: number | bigint | null
	lastErrorJson: unknown
	nextAttemptAt: Date
	status: string
	createdAt: Date
	updatedAt: Date
}

function rowToDispatch(r: DispatchYdbRow): ChannelDispatchRow {
	return {
		tenantId: r.tenantId,
		dispatchId: r.dispatchId,
		channelId: r.channelId,
		eventSource: r.eventSource,
		eventId: r.eventId,
		eventType: r.eventType,
		idempotencyKey: r.idempotencyKey,
		payload: r.payloadJson,
		attemptCount: typeof r.attemptCount === 'bigint' ? Number(r.attemptCount) : r.attemptCount,
		lastHttpStatus:
			r.lastHttpStatus === null
				? null
				: typeof r.lastHttpStatus === 'bigint'
					? Number(r.lastHttpStatus)
					: r.lastHttpStatus,
		lastErrorJson: r.lastErrorJson,
		nextAttemptAt: r.nextAttemptAt.toISOString(),
		status: r.status as DispatchStatus,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
	}
}

export function createChannelDispatchRepo(sql: SqlInstance) {
	return {
		async enqueue(input: ChannelDispatchEnqueue): Promise<{ readonly dispatchId: string }> {
			const dispatchId = randomUUID()
			const now = new Date()
			const nextAttempt = new Date(input.nextAttemptAtMs ?? Date.now())
			await sql`
				INSERT INTO channelDispatch (
					tenantId, dispatchId, channelId,
					eventSource, eventId, eventType,
					idempotencyKey, payloadJson,
					attemptCount, lastHttpStatus, lastErrorJson,
					nextAttemptAt, status, createdAt, updatedAt
				) VALUES (
					${input.tenantId}, ${dispatchId}, ${input.channelId},
					${input.eventSource}, ${input.eventId}, ${input.eventType},
					${input.idempotencyKey}, ${toJson(input.payload)},
					${0}, ${NULL_INT32}, ${toJson(null)},
					${nextAttempt}, ${'pending'}, ${now}, ${now}
				)
			`
			return { dispatchId }
		},

		async getById(input: {
			readonly tenantId: string
			readonly dispatchId: string
		}): Promise<ChannelDispatchRow | null> {
			const [rows = []] = await sql<DispatchYdbRow[]>`
				SELECT
					tenantId, dispatchId, channelId,
					eventSource, eventId, eventType,
					idempotencyKey, payloadJson,
					attemptCount, lastHttpStatus, lastErrorJson,
					nextAttemptAt, status, createdAt, updatedAt
				FROM channelDispatch
				WHERE tenantId = ${input.tenantId} AND dispatchId = ${input.dispatchId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToDispatch(row) : null
		},

		/**
		 * Atomic claim: SELECT pending rows due BY now, UPDATE nextAttemptAt += leaseMs
		 * inside same Serializable tx. Concurrent workers see leased rows as «not due».
		 *
		 * After HTTP attempt, worker calls `markSent` / `markFailed` / `markDlq` to
		 * overwrite nextAttemptAt with canonical schedule (per `computeNextAttemptAt`).
		 */
		async claimDueBatch(input: {
			readonly nowMs: number
			readonly limit: number
			readonly leaseMs: number
		}): Promise<ReadonlyArray<ChannelDispatchRow>> {
			// idempotent:true — claim is naturally idempotent (UPDATE sets
			// nextAttemptAt=leaseUntil; replay yields identical state). Required
			// for SDK retry under parallel-storm 400140 NOT_FOUND (session-tx
			// GC mid-block). @ydbjs/query 6.1.0 release-notes (2026-04-23):
			// «idempotent flag is honored end-to-end + attempt-scoped tx context».
			return sql.begin({ idempotent: true }, async (tx) => {
				const dueAt = new Date(input.nowMs)
				const leaseUntil = new Date(input.nowMs + input.leaseMs)
				const limit = Math.max(1, Math.min(input.limit, 1000))
				const [rows = []] = await tx<DispatchYdbRow[]>`
					SELECT
						tenantId, dispatchId, channelId,
						eventSource, eventId, eventType,
						idempotencyKey, payloadJson,
						attemptCount, lastHttpStatus, lastErrorJson,
						nextAttemptAt, status, createdAt, updatedAt
					FROM channelDispatch
					WHERE status = ${'pending'} AND nextAttemptAt <= ${dueAt}
					LIMIT ${limit}
				`
				if (rows.length === 0) return [] as ReadonlyArray<ChannelDispatchRow>
				for (const r of rows) {
					await tx`
						UPDATE channelDispatch
						SET nextAttemptAt = ${leaseUntil}, updatedAt = CurrentUtcTimestamp()
						WHERE tenantId = ${r.tenantId} AND dispatchId = ${r.dispatchId}
					`
				}
				return rows.map(rowToDispatch)
			})
		},

		async markSent(input: {
			readonly tenantId: string
			readonly dispatchId: string
			readonly httpStatus: number
		}): Promise<void> {
			await sql`
				UPDATE channelDispatch
				SET status = ${'sent'},
				    lastHttpStatus = ${input.httpStatus},
				    attemptCount = attemptCount + 1,
				    updatedAt = CurrentUtcTimestamp()
				WHERE tenantId = ${input.tenantId} AND dispatchId = ${input.dispatchId}
			`
		},

		async markRetry(input: {
			readonly tenantId: string
			readonly dispatchId: string
			readonly httpStatus: number | null
			readonly errorJson: unknown
			readonly nextAttemptAtMs: number
		}): Promise<void> {
			const httpStatusBind = input.httpStatus === null ? NULL_INT32 : input.httpStatus
			await sql`
				UPDATE channelDispatch
				SET status = ${'pending'},
				    lastHttpStatus = ${httpStatusBind},
				    lastErrorJson = ${toJson(input.errorJson)},
				    attemptCount = attemptCount + 1,
				    nextAttemptAt = ${new Date(input.nextAttemptAtMs)},
				    updatedAt = CurrentUtcTimestamp()
				WHERE tenantId = ${input.tenantId} AND dispatchId = ${input.dispatchId}
			`
		},

		async markDlq(input: {
			readonly tenantId: string
			readonly dispatchId: string
			readonly httpStatus: number | null
			readonly errorJson: unknown
		}): Promise<void> {
			const httpStatusBind = input.httpStatus === null ? NULL_INT32 : input.httpStatus
			await sql`
				UPDATE channelDispatch
				SET status = ${'dlq'},
				    lastHttpStatus = ${httpStatusBind},
				    lastErrorJson = ${toJson(input.errorJson)},
				    attemptCount = attemptCount + 1,
				    updatedAt = CurrentUtcTimestamp()
				WHERE tenantId = ${input.tenantId} AND dispatchId = ${input.dispatchId}
			`
		},

		async markDisabled(input: {
			readonly tenantId: string
			readonly channelId: string
			readonly reason: string
		}): Promise<{ readonly affected: number }> {
			const errorJson = { reason: input.reason, disabledAt: new Date().toISOString() }
			const [affectedRows = []] = await sql<DispatchYdbRow[]>`
				SELECT dispatchId FROM channelDispatch
				WHERE tenantId = ${input.tenantId}
				  AND channelId = ${input.channelId}
				  AND status = ${'pending'}
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			if (affectedRows.length === 0) return { affected: 0 }
			await sql`
				UPDATE channelDispatch
				SET status = ${'disabled'},
				    lastErrorJson = ${toJson(errorJson)},
				    updatedAt = CurrentUtcTimestamp()
				WHERE tenantId = ${input.tenantId}
				  AND channelId = ${input.channelId}
				  AND status = ${'pending'}
			`
			return { affected: affectedRows.length }
		},

		async listByTenant(
			tenantId: string,
			opts: { readonly limit?: number } = {},
		): Promise<ReadonlyArray<ChannelDispatchRow>> {
			const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000))
			const [rows = []] = await sql<DispatchYdbRow[]>`
				SELECT
					tenantId, dispatchId, channelId,
					eventSource, eventId, eventType,
					idempotencyKey, payloadJson,
					attemptCount, lastHttpStatus, lastErrorJson,
					nextAttemptAt, status, createdAt, updatedAt
				FROM channelDispatch
				WHERE tenantId = ${tenantId}
				LIMIT ${limit}
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToDispatch)
		},
	}
}
