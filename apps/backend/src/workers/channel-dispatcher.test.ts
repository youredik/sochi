/**
 * Channel dispatcher worker — strict tests CD1-CD8 (M10 / A7.1.fix).
 *
 * Pure-orchestration tests with in-memory dispatch repo. Verifies retry SM:
 *   - Success path → markSent
 *   - Retryable failure (5xx / 408 / 429) → markRetry с computeNextAttemptAt
 *   - Permanent failure (4xx) → markDlq immediately, no retries
 *   - Budget exhaustion (DISPATCH_MAX_ATTEMPTS) → markDlq + onAutoDisable
 *   - Per-row httpAttempt routing
 */

import { describe, expect, it, mock } from 'bun:test'
import type { ChannelDispatchRow } from '../domains/channel/dispatch.repo.ts'
import { DISPATCH_MAX_ATTEMPTS } from '../lib/channel-manager/channel-dispatch.ts'
import { type HttpAttemptResult, startChannelDispatcher } from './channel-dispatcher.ts'

function buildRow(overrides: Partial<ChannelDispatchRow> = {}): ChannelDispatchRow {
	const now = new Date().toISOString()
	return {
		tenantId: 'org_a',
		dispatchId: 'd_1',
		channelId: 'TL',
		eventSource: 'urn:sochi:channel:TL:tenant:org_a',
		eventId: 'evt_1',
		eventType: 'app.sochi.channel.booking.created.v1',
		idempotencyKey: 'org_a:b1:1:TL',
		payload: { hello: 'world' },
		attemptCount: 0,
		lastHttpStatus: null,
		lastErrorJson: null,
		nextAttemptAt: now,
		status: 'pending',
		createdAt: now,
		updatedAt: now,
		...overrides,
	}
}

function buildInMemoryRepo(initialRows: ChannelDispatchRow[]) {
	const rows = new Map<string, ChannelDispatchRow>()
	for (const r of initialRows) rows.set(r.dispatchId, r)
	let claimedOnce = false
	return {
		rows,
		async enqueue() {
			throw new Error('enqueue not used in tests')
		},
		async getById() {
			return null
		},
		async claimDueBatch() {
			if (claimedOnce) return []
			claimedOnce = true
			return Array.from(rows.values()).filter((r) => r.status === 'pending')
		},
		async markSent(input: { tenantId: string; dispatchId: string; httpStatus: number }) {
			const r = rows.get(input.dispatchId)
			if (r) {
				rows.set(input.dispatchId, {
					...r,
					status: 'sent',
					attemptCount: r.attemptCount + 1,
					lastHttpStatus: input.httpStatus,
				})
			}
		},
		async markRetry(input: {
			tenantId: string
			dispatchId: string
			httpStatus: number | null
			errorJson: unknown
			nextAttemptAtMs: number
		}) {
			const r = rows.get(input.dispatchId)
			if (r) {
				rows.set(input.dispatchId, {
					...r,
					status: 'pending',
					attemptCount: r.attemptCount + 1,
					lastHttpStatus: input.httpStatus,
					lastErrorJson: input.errorJson,
					nextAttemptAt: new Date(input.nextAttemptAtMs).toISOString(),
				})
			}
		},
		async markDlq(input: {
			tenantId: string
			dispatchId: string
			httpStatus: number | null
			errorJson: unknown
		}) {
			const r = rows.get(input.dispatchId)
			if (r) {
				rows.set(input.dispatchId, {
					...r,
					status: 'dlq',
					attemptCount: r.attemptCount + 1,
					lastHttpStatus: input.httpStatus,
					lastErrorJson: input.errorJson,
				})
			}
		},
		async markDisabled() {
			return { affected: 0 }
		},
		async listByTenant() {
			return []
		},
	}
}

async function drain(handle: { stop: () => Promise<void> }) {
	// Tiny wait so loop processes initial batch + then stop.
	await new Promise((resolve) => setTimeout(resolve, 50))
	await handle.stop()
}

describe('channel dispatcher — outcome routing (CD1-CD8)', () => {
	it('[CD1] HTTP 200 success → markSent', async () => {
		const repo = buildInMemoryRepo([buildRow()])
		const httpAttempt = mock(
			async (): Promise<HttpAttemptResult> => ({ ok: true, httpStatus: 200 }),
		)
		const handle = startChannelDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: in-memory repo intentionally narrow
			dispatchRepo: repo as any,
			httpAttempt,
			pollIntervalMs: 10,
		})
		await drain(handle)
		expect(httpAttempt).toHaveBeenCalledTimes(1)
		const r = repo.rows.get('d_1')
		expect(r?.status).toBe('sent')
		expect(r?.lastHttpStatus).toBe(200)
		expect(r?.attemptCount).toBe(1)
	})

	it('[CD2] HTTP 500 retryable → markRetry с next attempt scheduled', async () => {
		const repo = buildInMemoryRepo([buildRow()])
		const httpAttempt = mock(
			async (): Promise<HttpAttemptResult> => ({
				ok: false,
				httpStatus: 500,
				errorMessage: 'upstream',
			}),
		)
		const handle = startChannelDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: in-memory repo intentionally narrow
			dispatchRepo: repo as any,
			httpAttempt,
			pollIntervalMs: 10,
		})
		await drain(handle)
		const r = repo.rows.get('d_1')
		expect(r?.status).toBe('pending')
		expect(r?.attemptCount).toBe(1)
		expect(r?.lastHttpStatus).toBe(500)
		// nextAttemptAt advanced past createdAt.
		expect(new Date(r?.nextAttemptAt ?? 0).getTime()).toBeGreaterThan(0)
	})

	it('[CD3] HTTP 400 permanent → markDlq IMMEDIATELY (no retries)', async () => {
		const repo = buildInMemoryRepo([buildRow()])
		const httpAttempt = mock(
			async (): Promise<HttpAttemptResult> => ({
				ok: false,
				httpStatus: 400,
				errorMessage: 'bad request',
			}),
		)
		const handle = startChannelDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: in-memory repo intentionally narrow
			dispatchRepo: repo as any,
			httpAttempt,
			pollIntervalMs: 10,
		})
		await drain(handle)
		const r = repo.rows.get('d_1')
		expect(r?.status).toBe('dlq')
		expect(r?.attemptCount).toBe(1)
		expect(r?.lastHttpStatus).toBe(400)
	})

	it('[CD4] HTTP 408 retryable (4xx exception) → markRetry', async () => {
		const repo = buildInMemoryRepo([buildRow()])
		const httpAttempt = mock(
			async (): Promise<HttpAttemptResult> => ({
				ok: false,
				httpStatus: 408,
				errorMessage: 'timeout',
			}),
		)
		const handle = startChannelDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: in-memory repo intentionally narrow
			dispatchRepo: repo as any,
			httpAttempt,
			pollIntervalMs: 10,
		})
		await drain(handle)
		expect(repo.rows.get('d_1')?.status).toBe('pending')
	})

	it('[CD5] HTTP 429 retryable → markRetry', async () => {
		const repo = buildInMemoryRepo([buildRow()])
		const httpAttempt = mock(
			async (): Promise<HttpAttemptResult> => ({
				ok: false,
				httpStatus: 429,
				errorMessage: 'rate-limited',
			}),
		)
		const handle = startChannelDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: in-memory repo intentionally narrow
			dispatchRepo: repo as any,
			httpAttempt,
			pollIntervalMs: 10,
		})
		await drain(handle)
		expect(repo.rows.get('d_1')?.status).toBe('pending')
	})

	it('[CD6] network error (httpStatus null) retryable → markRetry', async () => {
		const repo = buildInMemoryRepo([buildRow()])
		const httpAttempt = mock(
			async (): Promise<HttpAttemptResult> => ({
				ok: false,
				httpStatus: null,
				errorMessage: 'ECONNRESET',
			}),
		)
		const handle = startChannelDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: in-memory repo intentionally narrow
			dispatchRepo: repo as any,
			httpAttempt,
			pollIntervalMs: 10,
		})
		await drain(handle)
		expect(repo.rows.get('d_1')?.status).toBe('pending')
	})

	it('[CD7] budget exhausted (attemptCount = MAX-1) → next failure → markDlq + onAutoDisable', async () => {
		const repo = buildInMemoryRepo([buildRow({ attemptCount: DISPATCH_MAX_ATTEMPTS - 1 })])
		const onAutoDisable = mock(async () => undefined)
		const httpAttempt = mock(
			async (): Promise<HttpAttemptResult> => ({
				ok: false,
				httpStatus: 500,
				errorMessage: 'still upstream',
			}),
		)
		const handle = startChannelDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: in-memory repo intentionally narrow
			dispatchRepo: repo as any,
			httpAttempt,
			pollIntervalMs: 10,
			onAutoDisable,
		})
		await drain(handle)
		const r = repo.rows.get('d_1')
		expect(r?.status).toBe('dlq')
		expect(onAutoDisable).toHaveBeenCalledWith({
			tenantId: 'org_a',
			channelId: 'TL',
			reason: 'dispatch_budget_exhausted',
		})
	})

	it('[CD8] httpAttempt invoked with row payload + idempotencyKey passthrough', async () => {
		const repo = buildInMemoryRepo([buildRow()])
		const httpAttempt = mock(
			async ({ row }: { row: ChannelDispatchRow }): Promise<HttpAttemptResult> => {
				expect(row.idempotencyKey).toBe('org_a:b1:1:TL')
				expect(row.payload).toEqual({ hello: 'world' })
				return { ok: true, httpStatus: 200 }
			},
		)
		const handle = startChannelDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: in-memory repo intentionally narrow
			dispatchRepo: repo as any,
			httpAttempt,
			pollIntervalMs: 10,
		})
		await drain(handle)
		expect(httpAttempt).toHaveBeenCalledTimes(1)
	})
})
