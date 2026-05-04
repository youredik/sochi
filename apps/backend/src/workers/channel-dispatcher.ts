/**
 * Channel dispatcher worker — M10 / A7.1.fix (D14 + D14.b).
 *
 * Outbound HTTP delivery loop. Reads pending rows из `channelDispatch` table,
 * delegates HTTP attempt к per-channel adapter, applies Hookdeck tiered retry
 * schedule (`computeNextAttemptAt`) on failure, marks DLQ after budget exhausted.
 *
 * Per `plans/m10_canonical.md` §2 D14 (Hookdeck tiered, NOT exponential):
 *   - 100ms → 500ms → 1m → 5m → 15m → 30m → 1h × 5-10 → hourly to 72h → DLQ
 *   - Per-(tenantId, channelId) circuit breaker auto-disable after 7 days
 *     continuous failure (Apaleo precedent, `shouldAutoDisable`)
 *
 * Architecture:
 *   - Single long-lived Promise loop (per-process). Polls every `pollIntervalMs`
 *     для pending rows.
 *   - Atomic claim via repo.claimDueBatch: SELECT pending WHERE nextAttemptAt
 *     ≤ now LIMIT N inside Serializable tx, lease nextAttemptAt += leaseMs
 *     so concurrent dispatchers don't double-attempt.
 *   - Per-row HTTP attempt uses the channel adapter's `pushAri` / `createBooking`
 *     surface — but A7.1.fix wires only the GENERIC dispatch primitive: каждый
 *     event с `eventType` routes к downstream `httpAttempt(payload, channelId)`
 *     callback supplied by caller. A7.2/A7.3/A7.4 register channel-specific
 *     handlers that map к adapter methods.
 *
 * Idempotency: `idempotencyKey` propagates в HTTP header (canonical Stripe-style)
 * + body when channel API supports neither (TL is body-only).
 */
import { setTimeout as sleep } from 'node:timers/promises'
import type {
	ChannelDispatchRow,
	createChannelDispatchRepo,
} from '../domains/channel/dispatch.repo.ts'
import {
	computeNextAttemptAt,
	DISPATCH_MAX_ATTEMPTS,
	isRetryableFailure,
} from '../lib/channel-manager/channel-dispatch.ts'
import { logger } from '../logger.ts'

export type HttpAttemptResult =
	| { readonly ok: true; readonly httpStatus: number; readonly responseBody?: unknown }
	| {
			readonly ok: false
			readonly httpStatus: number | null
			readonly errorMessage: string
			readonly responseBody?: unknown
	  }

export interface ChannelDispatcherDeps {
	readonly dispatchRepo: ReturnType<typeof createChannelDispatchRepo>
	/**
	 * Per-(channelId, eventType) HTTP attempt callback. Adapter-specific routing
	 * registered by A7.2/A7.3/A7.4. Receives idempotency-key — channel SHOULD
	 * propagate в HTTP header OR body.
	 */
	readonly httpAttempt: (input: { readonly row: ChannelDispatchRow }) => Promise<HttpAttemptResult>
	/**
	 * Optional auto-disable handler. Called when a channel hits `shouldAutoDisable`
	 * threshold. Implementer marks `channelConnection.syncStatus='auto_disabled'`
	 * + emits admin alert event.
	 */
	readonly onAutoDisable?: (input: {
		readonly tenantId: string
		readonly channelId: string
		readonly reason: string
	}) => Promise<void>
	readonly pollIntervalMs?: number
	readonly batchLimit?: number
	readonly leaseMs?: number
	readonly nowMs?: () => number
}

export interface DispatcherHandle {
	stop(): Promise<void>
}

const DEFAULT_POLL_MS = 250
const DEFAULT_BATCH_LIMIT = 50
const DEFAULT_LEASE_MS = 30_000

/**
 * Start the dispatcher loop. Returns a handle с `stop()` для graceful shutdown.
 *
 * Wired в app.ts at startup (only when channel adapters are registered);
 * stopped in app shutdown hook.
 */
export function startChannelDispatcher(deps: ChannelDispatcherDeps): DispatcherHandle {
	const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS
	const batchLimit = deps.batchLimit ?? DEFAULT_BATCH_LIMIT
	const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS
	const nowMs = deps.nowMs ?? (() => Date.now())

	let stopped = false
	let inflight: Promise<void> = Promise.resolve()
	const ctrl = new AbortController()

	async function loop() {
		while (!stopped) {
			try {
				const claimed = await deps.dispatchRepo.claimDueBatch({
					nowMs: nowMs(),
					limit: batchLimit,
					leaseMs,
				})
				if (claimed.length === 0) {
					await sleep(pollIntervalMs, undefined, { signal: ctrl.signal }).catch(() => undefined)
					continue
				}
				await Promise.all(
					claimed.map((row) =>
						processRow(deps, row, nowMs).catch((err) => {
							logger.error(
								{ err, dispatchId: row.dispatchId, tenantId: row.tenantId },
								'channel dispatcher: row processing crashed',
							)
						}),
					),
				)
			} catch (err) {
				logger.error({ err }, 'channel dispatcher: claim batch failed')
				await sleep(pollIntervalMs, undefined, { signal: ctrl.signal }).catch(() => undefined)
			}
		}
	}

	inflight = loop()

	return {
		async stop() {
			stopped = true
			ctrl.abort()
			await inflight
		},
	}
}

async function processRow(
	deps: ChannelDispatcherDeps,
	row: ChannelDispatchRow,
	nowMs: () => number,
): Promise<void> {
	const result = await deps.httpAttempt({ row })

	if (result.ok) {
		await deps.dispatchRepo.markSent({
			tenantId: row.tenantId,
			dispatchId: row.dispatchId,
			httpStatus: result.httpStatus,
		})
		return
	}

	const newAttemptCount = row.attemptCount + 1

	// Permanent failure (4xx non-retryable) → DLQ immediately, no schedule.
	if (!isRetryableFailure({ httpStatus: result.httpStatus ?? undefined })) {
		await deps.dispatchRepo.markDlq({
			tenantId: row.tenantId,
			dispatchId: row.dispatchId,
			httpStatus: result.httpStatus,
			errorJson: { message: result.errorMessage, response: result.responseBody ?? null },
		})
		return
	}

	// Budget exhausted → DLQ.
	if (newAttemptCount >= DISPATCH_MAX_ATTEMPTS) {
		await deps.dispatchRepo.markDlq({
			tenantId: row.tenantId,
			dispatchId: row.dispatchId,
			httpStatus: result.httpStatus,
			errorJson: {
				message: result.errorMessage,
				exhaustedAfter: newAttemptCount,
			},
		})
		if (deps.onAutoDisable) {
			await deps.onAutoDisable({
				tenantId: row.tenantId,
				channelId: row.channelId,
				reason: 'dispatch_budget_exhausted',
			})
		}
		return
	}

	// Retryable — schedule next attempt.
	const next = computeNextAttemptAt({
		attemptCount: newAttemptCount,
		firstAttemptAtMs: new Date(row.createdAt).getTime(),
	})
	if (next === null) {
		await deps.dispatchRepo.markDlq({
			tenantId: row.tenantId,
			dispatchId: row.dispatchId,
			httpStatus: result.httpStatus,
			errorJson: { message: result.errorMessage, scheduleExhausted: true },
		})
		return
	}
	await deps.dispatchRepo.markRetry({
		tenantId: row.tenantId,
		dispatchId: row.dispatchId,
		httpStatus: result.httpStatus,
		errorJson: { message: result.errorMessage, attemptCount: newAttemptCount },
		nextAttemptAtMs: Math.max(next, nowMs() + 100),
	})
}
