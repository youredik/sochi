/**
 * Channel dispatcher onDispatchOutcome callback — strict tests OUT1-OUT4
 * (M10 / A7.5.fix).
 *
 * Verifies that admin overlay UI gets fresh sync state after each dispatch:
 *   - sent → outcome='sent' (UI shows lastSyncAt updated, syncStatus='idle')
 *   - retry → outcome='retry' (UI shows syncStatus='syncing')
 *   - dlq → outcome='dlq' (UI shows syncStatus='error' + errorMessage)
 *   - budget exhausted → outcome='auto_disabled' (UI shows auto-disabled badge)
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
		idempotencyKey: 'k1',
		payload: {},
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
			throw new Error('not used')
		},
		async getById() {
			return null
		},
		async claimDueBatch() {
			if (claimedOnce) return []
			claimedOnce = true
			return Array.from(rows.values()).filter((r) => r.status === 'pending')
		},
		async markSent() {},
		async markRetry() {},
		async markDlq() {},
		async markDisabled() {
			return { affected: 0 }
		},
		async listByTenant() {
			return []
		},
	}
}

async function drain(handle: { stop: () => Promise<void> }) {
	await new Promise((resolve) => setTimeout(resolve, 50))
	await handle.stop()
}

describe('channel dispatcher — onDispatchOutcome (OUT1-OUT5)', () => {
	it('[OUT1] HTTP 200 → outcome=sent', async () => {
		const repo = buildInMemoryRepo([buildRow()])
		const onDispatchOutcome = mock(async () => undefined)
		const handle = startChannelDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: in-memory repo intentionally narrow
			dispatchRepo: repo as any,
			httpAttempt: async (): Promise<HttpAttemptResult> => ({ ok: true, httpStatus: 200 }),
			onDispatchOutcome,
			pollIntervalMs: 10,
		})
		await drain(handle)
		expect(onDispatchOutcome).toHaveBeenCalledWith({
			tenantId: 'org_a',
			channelId: 'TL',
			outcome: 'sent',
		})
	})

	it('[OUT2] HTTP 500 retryable → outcome=retry', async () => {
		const repo = buildInMemoryRepo([buildRow()])
		const onDispatchOutcome = mock(async () => undefined)
		const handle = startChannelDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: in-memory repo intentionally narrow
			dispatchRepo: repo as any,
			httpAttempt: async (): Promise<HttpAttemptResult> => ({
				ok: false,
				httpStatus: 500,
				errorMessage: 'upstream error',
			}),
			onDispatchOutcome,
			pollIntervalMs: 10,
		})
		await drain(handle)
		expect(onDispatchOutcome).toHaveBeenCalledWith({
			tenantId: 'org_a',
			channelId: 'TL',
			outcome: 'retry',
			errorMessage: 'upstream error',
		})
	})

	it('[OUT3] HTTP 400 permanent → outcome=dlq', async () => {
		const repo = buildInMemoryRepo([buildRow()])
		const onDispatchOutcome = mock(async () => undefined)
		const handle = startChannelDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: in-memory repo intentionally narrow
			dispatchRepo: repo as any,
			httpAttempt: async (): Promise<HttpAttemptResult> => ({
				ok: false,
				httpStatus: 400,
				errorMessage: 'bad request',
			}),
			onDispatchOutcome,
			pollIntervalMs: 10,
		})
		await drain(handle)
		expect(onDispatchOutcome).toHaveBeenCalledWith({
			tenantId: 'org_a',
			channelId: 'TL',
			outcome: 'dlq',
			errorMessage: 'bad request',
		})
	})

	it('[OUT4] budget exhausted → outcome=auto_disabled', async () => {
		const repo = buildInMemoryRepo([buildRow({ attemptCount: DISPATCH_MAX_ATTEMPTS - 1 })])
		const onDispatchOutcome = mock(async () => undefined)
		const handle = startChannelDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: in-memory repo intentionally narrow
			dispatchRepo: repo as any,
			httpAttempt: async (): Promise<HttpAttemptResult> => ({
				ok: false,
				httpStatus: 500,
				errorMessage: 'still upstream',
			}),
			onDispatchOutcome,
			pollIntervalMs: 10,
		})
		await drain(handle)
		expect(onDispatchOutcome).toHaveBeenCalledWith({
			tenantId: 'org_a',
			channelId: 'TL',
			outcome: 'auto_disabled',
			errorMessage: 'still upstream',
		})
	})

	it('[OUT5] onDispatchOutcome optional — undefined callback works without crash', async () => {
		const repo = buildInMemoryRepo([buildRow()])
		const handle = startChannelDispatcher({
			// biome-ignore lint/suspicious/noExplicitAny: in-memory repo intentionally narrow
			dispatchRepo: repo as any,
			httpAttempt: async (): Promise<HttpAttemptResult> => ({ ok: true, httpStatus: 200 }),
			pollIntervalMs: 10,
		})
		await drain(handle)
		// Just no crash — no assertion needed beyond that.
		expect(true).toBe(true)
	})
})
