/**
 * Channel manager runtime factory — M10 / A7.1.fix.
 *
 * Wires repos + per-tenant adapter cache + dispatcher worker + webhook routes.
 * Adapter implementations (A7.2 TravelLine, A7.3 Yandex.Travel, A7.4 Ostrovok ETG)
 * register their per-channel HTTP attempt handlers via `registerHttpAttempt`.
 *
 * Mounting (in app.ts):
 *   - `app.route('/api/channel', channelFactory.webhookRoutes)` — public, no auth,
 *      raw-body Standard Webhooks signature verify
 *   - `channelFactory.dispatcher` started at boot (or NODE_ENV !== 'test'),
 *      stopped в `stopApp`
 */

import type { sql as SQL } from '../../db/index.ts'
import type { ChannelManagerAdapter } from '../../lib/channel-manager/adapter.ts'
import type { SochiCloudEvent } from '../../lib/channel-manager/cloud-events.ts'
import {
	createPerTenantAdapterCache,
	resolveAdapter,
} from '../../lib/channel-manager/tenant-context.ts'
import { logger } from '../../logger.ts'
import {
	type ChannelDispatcherDeps,
	type DispatcherHandle,
	type HttpAttemptResult,
	startChannelDispatcher,
} from '../../workers/channel-dispatcher.ts'
import { createChannelConnectionRepo } from './connection.repo.ts'
import { createChannelDispatchRepo } from './dispatch.repo.ts'
import { createInboxRepo } from './inbox.repo.ts'
import { createInventoryPoolRepo } from './inventory-pool.repo.ts'
import { SANCTIONED_CHANNEL_IDS } from './sync-orchestrator.ts'
import { createChannelWebhookRoutes } from './webhook.routes.ts'
import { createWebhookSecretRepo } from './webhook-secret.repo.ts'

/**
 * D16 sanctions HARD-DISABLE — defense-in-depth at factory level.
 * Refused at registration AND orchestrator gate (see sync-orchestrator.ts).
 *
 * Re-enable trigger: sanctions lift + RKN re-notify + manual code change.
 */
export class SanctionedChannelError extends Error {
	readonly httpStatus = 451 // RFC 7725 — Unavailable For Legal Reasons
	constructor(channelId: string) {
		super(
			`Channel '${channelId}' is HARD-DISABLED at factory level (D16 sanctions May 2026: ` +
				'Booking.com / Expedia / Airbnb refused for РФ). Re-enable requires sanctions ' +
				'lift + RKN re-notify + manual code change.',
		)
		this.name = 'SanctionedChannelError'
	}
}

type SqlInstance = typeof SQL

export interface ChannelFactory {
	readonly connectionRepo: ReturnType<typeof createChannelConnectionRepo>
	readonly dispatchRepo: ReturnType<typeof createChannelDispatchRepo>
	readonly inboxRepo: ReturnType<typeof createInboxRepo>
	readonly inventoryPoolRepo: ReturnType<typeof createInventoryPoolRepo>
	readonly secretRepo: ReturnType<typeof createWebhookSecretRepo>
	readonly adapterCache: ReturnType<typeof createPerTenantAdapterCache>
	/**
	 * Resolve adapter for (organizationId, channelId). Reads
	 * `organizationProfile.adapterVersion` for cache-bust signal.
	 */
	resolveAdapter(input: {
		readonly organizationId: string
		readonly channelId: string
	}): Promise<ChannelManagerAdapter>
	registerAdapterFactory(
		channelId: string,
		factory: (input: { readonly organizationId: string }) => Promise<ChannelManagerAdapter>,
	): void
	/**
	 * Per-channel HTTP attempt handler registry. A7.2/A7.3/A7.4 call to bind
	 * their own delivery surface. Falls back to a 501-stub for unmapped channels.
	 */
	registerHttpAttempt(
		channelId: string,
		handler: (input: {
			readonly tenantId: string
			readonly eventType: string
			readonly idempotencyKey: string
			readonly payload: unknown
		}) => Promise<HttpAttemptResult>,
	): void
	readonly webhookRoutes: ReturnType<typeof createChannelWebhookRoutes>
	readonly dispatcher: DispatcherHandle | null
	stopDispatcher(): Promise<void>
}

export interface ChannelFactoryOptions {
	readonly enableDispatcher?: boolean
	readonly dispatcherDeps?: Partial<Omit<ChannelDispatcherDeps, 'dispatchRepo' | 'httpAttempt'>>
	/**
	 * Optional inbound webhook routes hooks.
	 *  - `onAccepted` is invoked for `accepted` (first-delivery) events. A7.5
	 *    sync orchestrator will register a handler that emits sync events
	 *    downstream. NULL by default (echoes ack).
	 *  - `ipAllowlist` keyed by channelId (e.g. ЮKassa-style channels with
	 *    no HMAC). Empty by default.
	 */
	readonly onAcceptedWebhook?: (input: {
		readonly channelId: string
		readonly event: SochiCloudEvent
	}) => Promise<unknown>
	readonly webhookIpAllowlist?: ReadonlyMap<string, ReadonlyArray<string>>
}

const STUB_NOT_IMPLEMENTED: HttpAttemptResult = {
	ok: false,
	httpStatus: 501,
	errorMessage: 'channel_http_attempt_not_registered',
}

export function createChannelFactory(
	sql: SqlInstance,
	opts: ChannelFactoryOptions = {},
): ChannelFactory {
	const connectionRepo = createChannelConnectionRepo(sql)
	const dispatchRepo = createChannelDispatchRepo(sql)
	const inboxRepo = createInboxRepo(sql)
	const inventoryPoolRepo = createInventoryPoolRepo(sql)
	const secretRepo = createWebhookSecretRepo(sql)
	const adapterCache = createPerTenantAdapterCache()

	const adapterFactories = new Map<
		string,
		(input: { readonly organizationId: string }) => Promise<ChannelManagerAdapter>
	>()
	const httpAttempts = new Map<
		string,
		(input: {
			readonly tenantId: string
			readonly eventType: string
			readonly idempotencyKey: string
			readonly payload: unknown
		}) => Promise<HttpAttemptResult>
	>()

	async function versionLookup(organizationId: string): Promise<bigint> {
		const [rows = []] = await sql<{ adapterVersion: bigint | number | null }[]>`
			SELECT adapterVersion FROM organizationProfile WHERE organizationId = ${organizationId} LIMIT 1
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		const row = rows[0]
		if (!row || row.adapterVersion === null || row.adapterVersion === undefined) return 1n
		return typeof row.adapterVersion === 'bigint' ? row.adapterVersion : BigInt(row.adapterVersion)
	}

	async function defaultFactory(input: {
		readonly organizationId: string
		readonly channelId: string
	}): Promise<ChannelManagerAdapter> {
		const f = adapterFactories.get(input.channelId)
		if (!f) {
			throw new Error(
				`channel adapter not registered: channelId='${input.channelId}'. ` +
					'A7.2/A7.3/A7.4 sub-phases must call registerAdapterFactory().',
			)
		}
		return f(input)
	}

	const webhookRoutes = createChannelWebhookRoutes({
		inboxRepo,
		secretRepo,
		connectionRepo, // Round 8 P1-6: required для cross-tenant authorization on inbound webhooks
		...(opts.webhookIpAllowlist !== undefined ? { ipAllowlist: opts.webhookIpAllowlist } : {}),
		...(opts.onAcceptedWebhook !== undefined ? { onAccepted: opts.onAcceptedWebhook } : {}),
	})

	let dispatcher: DispatcherHandle | null = null
	if (opts.enableDispatcher) {
		dispatcher = startChannelDispatcher({
			dispatchRepo,
			httpAttempt: async ({ row }) => {
				const handler = httpAttempts.get(row.channelId)
				if (!handler) return STUB_NOT_IMPLEMENTED
				return handler({
					tenantId: row.tenantId,
					eventType: row.eventType,
					idempotencyKey: row.idempotencyKey,
					payload: row.payload,
				})
			},
			// A7.5.fix — update channelConnection state after dispatch outcome
			// so admin overlay UI shows live sync activity.
			onDispatchOutcome: async ({ tenantId, channelId, outcome, errorMessage }) => {
				try {
					const matches = await connectionRepo.listByTenant(tenantId)
					const targets = matches.filter((c) => c.channelId === channelId)
					for (const c of targets) {
						const patch =
							outcome === 'sent'
								? {
										syncStatus: 'idle' as const,
										lastSyncAt: new Date().toISOString(),
										autoDisabledReason: null,
									}
								: outcome === 'retry'
									? {
											syncStatus: 'syncing' as const,
											autoDisabledReason: errorMessage ?? null,
										}
									: outcome === 'dlq'
										? {
												syncStatus: 'error' as const,
												autoDisabledReason: errorMessage ?? null,
											}
										: {
												syncStatus: 'auto_disabled' as const,
												autoDisabledReason: errorMessage ?? null,
												autoDisabledAt: new Date().toISOString(),
											}
						await connectionRepo.patch(
							{
								tenantId: c.tenantId,
								propertyId: c.propertyId,
								channelId: c.channelId,
							},
							patch,
						)
					}
				} catch (err) {
					logger.error(
						{ err, tenantId, channelId, outcome },
						'channel.factory: onDispatchOutcome connection patch failed',
					)
				}
			},
			...(opts.dispatcherDeps ?? {}),
		})
	}

	return {
		connectionRepo,
		dispatchRepo,
		inboxRepo,
		inventoryPoolRepo,
		secretRepo,
		adapterCache,
		async resolveAdapter(input) {
			return resolveAdapter({ cache: adapterCache, versionLookup, factory: defaultFactory }, input)
		},
		registerAdapterFactory(channelId, factory) {
			// D16 factory-level sanctions HARD-DISABLE (defense-in-depth).
			if (SANCTIONED_CHANNEL_IDS.has(channelId)) {
				throw new SanctionedChannelError(channelId)
			}
			if (adapterFactories.has(channelId)) {
				throw new Error(`channel adapter factory already registered: ${channelId}`)
			}
			adapterFactories.set(channelId, factory)
		},
		registerHttpAttempt(channelId, handler) {
			if (SANCTIONED_CHANNEL_IDS.has(channelId)) {
				throw new SanctionedChannelError(channelId)
			}
			if (httpAttempts.has(channelId)) {
				throw new Error(`channel httpAttempt already registered: ${channelId}`)
			}
			httpAttempts.set(channelId, handler)
		},
		webhookRoutes,
		dispatcher,
		async stopDispatcher() {
			if (dispatcher) await dispatcher.stop()
			dispatcher = null
		},
	}
}
