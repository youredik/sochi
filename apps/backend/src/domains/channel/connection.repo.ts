/**
 * Channel connection repo — M10 / A7.1.fix.
 *
 * CRUD над `channelConnection` (migration 0050) — per-tenant per-property
 * adapter binding. Each row = one (tenant, property, channel) tuple.
 *
 * Per `feedback_pre_done_audit.md` matrix:
 *   - Cross-tenant isolation absolute (every read filters by tenantId)
 *   - PK = (tenantId, propertyId, channelId) — 3-dim independence
 *   - All write methods no-op cross-tenant
 *
 * Patch semantics three-state:
 *   - `undefined` ⇒ no change to stored field
 *   - explicit `null` ⇒ clear the column (set DB to NULL)
 *   - value ⇒ overwrite
 */

import type { sql as SQL } from '../../db/index.ts'
import { NULL_TIMESTAMP, textOpt, timestampOpt } from '../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

export type ChannelConnectionMode = 'mock' | 'sandbox' | 'live'
export type ChannelConnectionRole =
	| 'processor_with_dpa'
	| 'independent_operator'
	| 'foreign_recipient'
export type ChannelConnectionSyncStatus = 'idle' | 'syncing' | 'error' | 'auto_disabled'
export type CrossBorderNotificationStatus = 'filed' | 'pending' | 'denied'

export interface ChannelConnection {
	readonly tenantId: string
	readonly propertyId: string
	readonly channelId: string
	readonly mode: ChannelConnectionMode
	readonly role: ChannelConnectionRole
	readonly credentialsLockboxRef: string | null
	readonly dpaSignedAt: string | null
	readonly rknOperatorId: string | null
	readonly crossBorderNotificationStatus: CrossBorderNotificationStatus | null
	readonly syncStatus: ChannelConnectionSyncStatus
	readonly lastSyncAt: string | null
	readonly autoDisabledReason: string | null
	readonly autoDisabledAt: string | null
	readonly isEnabled: boolean
	readonly createdAt: string
	readonly updatedAt: string
}

export interface ChannelConnectionCreate {
	readonly tenantId: string
	readonly propertyId: string
	readonly channelId: string
	readonly mode: ChannelConnectionMode
	readonly role: ChannelConnectionRole
	readonly credentialsLockboxRef?: string | null
	readonly dpaSignedAt?: string | null
	readonly rknOperatorId?: string | null
	readonly isEnabled: boolean
}

export interface ChannelConnectionPatch {
	readonly mode?: ChannelConnectionMode
	readonly role?: ChannelConnectionRole
	readonly credentialsLockboxRef?: string | null
	readonly dpaSignedAt?: string | null
	readonly rknOperatorId?: string | null
	readonly crossBorderNotificationStatus?: CrossBorderNotificationStatus | null
	readonly syncStatus?: ChannelConnectionSyncStatus
	readonly lastSyncAt?: string | null
	readonly autoDisabledReason?: string | null
	readonly autoDisabledAt?: string | null
	readonly isEnabled?: boolean
}

type ChannelConnectionRow = {
	tenantId: string
	propertyId: string
	channelId: string
	mode: string
	role: string
	credentialsLockboxRef: string | null
	dpaSignedAt: Date | null
	rknOperatorId: string | null
	crossBorderNotificationStatus: string | null
	syncStatus: string
	lastSyncAt: Date | null
	autoDisabledReason: string | null
	autoDisabledAt: Date | null
	isEnabled: boolean
	createdAt: Date
	updatedAt: Date
}

function rowToConnection(r: ChannelConnectionRow): ChannelConnection {
	return {
		tenantId: r.tenantId,
		propertyId: r.propertyId,
		channelId: r.channelId,
		mode: r.mode as ChannelConnectionMode,
		role: r.role as ChannelConnectionRole,
		credentialsLockboxRef: r.credentialsLockboxRef,
		dpaSignedAt: r.dpaSignedAt ? r.dpaSignedAt.toISOString() : null,
		rknOperatorId: r.rknOperatorId,
		crossBorderNotificationStatus:
			r.crossBorderNotificationStatus as CrossBorderNotificationStatus | null,
		syncStatus: r.syncStatus as ChannelConnectionSyncStatus,
		lastSyncAt: r.lastSyncAt ? r.lastSyncAt.toISOString() : null,
		autoDisabledReason: r.autoDisabledReason,
		autoDisabledAt: r.autoDisabledAt ? r.autoDisabledAt.toISOString() : null,
		isEnabled: r.isEnabled,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
	}
}

export function createChannelConnectionRepo(sql: SqlInstance) {
	return {
		async create(input: ChannelConnectionCreate): Promise<ChannelConnection> {
			const now = new Date()
			await sql`
				INSERT INTO channelConnection (
					tenantId, propertyId, channelId, mode, role,
					credentialsLockboxRef, dpaSignedAt, rknOperatorId,
					crossBorderNotificationStatus, syncStatus,
					lastSyncAt, autoDisabledReason, autoDisabledAt,
					isEnabled, createdAt, updatedAt
				) VALUES (
					${input.tenantId}, ${input.propertyId}, ${input.channelId},
					${input.mode}, ${input.role},
					${textOpt(input.credentialsLockboxRef ?? null)},
					${input.dpaSignedAt ? timestampOpt(new Date(input.dpaSignedAt)) : NULL_TIMESTAMP},
					${textOpt(input.rknOperatorId ?? null)},
					${textOpt(null)}, ${'idle'},
					${NULL_TIMESTAMP}, ${textOpt(null)}, ${NULL_TIMESTAMP},
					${input.isEnabled}, ${now}, ${now}
				)
			`
			return {
				tenantId: input.tenantId,
				propertyId: input.propertyId,
				channelId: input.channelId,
				mode: input.mode,
				role: input.role,
				credentialsLockboxRef: input.credentialsLockboxRef ?? null,
				dpaSignedAt: input.dpaSignedAt ?? null,
				rknOperatorId: input.rknOperatorId ?? null,
				crossBorderNotificationStatus: null,
				syncStatus: 'idle',
				lastSyncAt: null,
				autoDisabledReason: null,
				autoDisabledAt: null,
				isEnabled: input.isEnabled,
				createdAt: now.toISOString(),
				updatedAt: now.toISOString(),
			}
		},

		async get(input: {
			readonly tenantId: string
			readonly propertyId: string
			readonly channelId: string
		}): Promise<ChannelConnection | null> {
			const [rows = []] = await sql<ChannelConnectionRow[]>`
				SELECT
					tenantId, propertyId, channelId, mode, role,
					credentialsLockboxRef, dpaSignedAt, rknOperatorId,
					crossBorderNotificationStatus, syncStatus,
					lastSyncAt, autoDisabledReason, autoDisabledAt,
					isEnabled, createdAt, updatedAt
				FROM channelConnection
				WHERE tenantId = ${input.tenantId}
				  AND propertyId = ${input.propertyId}
				  AND channelId = ${input.channelId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToConnection(row) : null
		},

		async listByTenant(tenantId: string): Promise<ReadonlyArray<ChannelConnection>> {
			const [rows = []] = await sql<ChannelConnectionRow[]>`
				SELECT
					tenantId, propertyId, channelId, mode, role,
					credentialsLockboxRef, dpaSignedAt, rknOperatorId,
					crossBorderNotificationStatus, syncStatus,
					lastSyncAt, autoDisabledReason, autoDisabledAt,
					isEnabled, createdAt, updatedAt
				FROM channelConnection
				WHERE tenantId = ${tenantId}
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToConnection)
		},

		/**
		 * Patch with three-state semantics. Cross-tenant no-op: row is keyed
		 * by (tenantId, propertyId, channelId); attempting to patch with
		 * a different tenantId silently affects 0 rows (test verifies this).
		 */
		async patch(
			input: {
				readonly tenantId: string
				readonly propertyId: string
				readonly channelId: string
			},
			patch: ChannelConnectionPatch,
		): Promise<ChannelConnection | null> {
			return sql.begin({ idempotent: true }, async (tx) => {
				const [rows = []] = await tx<ChannelConnectionRow[]>`
					SELECT
						tenantId, propertyId, channelId, mode, role,
						credentialsLockboxRef, dpaSignedAt, rknOperatorId,
						crossBorderNotificationStatus, syncStatus,
						lastSyncAt, autoDisabledReason, autoDisabledAt,
						isEnabled, createdAt, updatedAt
					FROM channelConnection
					WHERE tenantId = ${input.tenantId}
					  AND propertyId = ${input.propertyId}
					  AND channelId = ${input.channelId}
					LIMIT 1
				`
				const row = rows[0]
				if (!row) return null

				const merged = {
					mode:
						'mode' in patch && patch.mode !== undefined
							? patch.mode
							: (row.mode as ChannelConnectionMode),
					role:
						'role' in patch && patch.role !== undefined
							? patch.role
							: (row.role as ChannelConnectionRole),
					credentialsLockboxRef:
						'credentialsLockboxRef' in patch && patch.credentialsLockboxRef !== undefined
							? patch.credentialsLockboxRef
							: row.credentialsLockboxRef,
					dpaSignedAt:
						'dpaSignedAt' in patch && patch.dpaSignedAt !== undefined
							? patch.dpaSignedAt
							: row.dpaSignedAt
								? row.dpaSignedAt.toISOString()
								: null,
					rknOperatorId:
						'rknOperatorId' in patch && patch.rknOperatorId !== undefined
							? patch.rknOperatorId
							: row.rknOperatorId,
					crossBorderNotificationStatus:
						'crossBorderNotificationStatus' in patch &&
						patch.crossBorderNotificationStatus !== undefined
							? patch.crossBorderNotificationStatus
							: (row.crossBorderNotificationStatus as CrossBorderNotificationStatus | null),
					syncStatus:
						'syncStatus' in patch && patch.syncStatus !== undefined
							? patch.syncStatus
							: (row.syncStatus as ChannelConnectionSyncStatus),
					lastSyncAt:
						'lastSyncAt' in patch && patch.lastSyncAt !== undefined
							? patch.lastSyncAt
							: row.lastSyncAt
								? row.lastSyncAt.toISOString()
								: null,
					autoDisabledReason:
						'autoDisabledReason' in patch && patch.autoDisabledReason !== undefined
							? patch.autoDisabledReason
							: row.autoDisabledReason,
					autoDisabledAt:
						'autoDisabledAt' in patch && patch.autoDisabledAt !== undefined
							? patch.autoDisabledAt
							: row.autoDisabledAt
								? row.autoDisabledAt.toISOString()
								: null,
					isEnabled:
						'isEnabled' in patch && patch.isEnabled !== undefined ? patch.isEnabled : row.isEnabled,
				}

				await tx`
					UPDATE channelConnection SET
						mode = ${merged.mode},
						role = ${merged.role},
						credentialsLockboxRef = ${textOpt(merged.credentialsLockboxRef)},
						dpaSignedAt = ${merged.dpaSignedAt ? timestampOpt(new Date(merged.dpaSignedAt)) : NULL_TIMESTAMP},
						rknOperatorId = ${textOpt(merged.rknOperatorId)},
						crossBorderNotificationStatus = ${textOpt(merged.crossBorderNotificationStatus)},
						syncStatus = ${merged.syncStatus},
						lastSyncAt = ${merged.lastSyncAt ? timestampOpt(new Date(merged.lastSyncAt)) : NULL_TIMESTAMP},
						autoDisabledReason = ${textOpt(merged.autoDisabledReason)},
						autoDisabledAt = ${merged.autoDisabledAt ? timestampOpt(new Date(merged.autoDisabledAt)) : NULL_TIMESTAMP},
						isEnabled = ${merged.isEnabled},
						updatedAt = CurrentUtcTimestamp()
					WHERE tenantId = ${input.tenantId}
					  AND propertyId = ${input.propertyId}
					  AND channelId = ${input.channelId}
				`

				return {
					tenantId: row.tenantId,
					propertyId: row.propertyId,
					channelId: row.channelId,
					mode: merged.mode,
					role: merged.role,
					credentialsLockboxRef: merged.credentialsLockboxRef,
					dpaSignedAt: merged.dpaSignedAt,
					rknOperatorId: merged.rknOperatorId,
					crossBorderNotificationStatus: merged.crossBorderNotificationStatus,
					syncStatus: merged.syncStatus,
					lastSyncAt: merged.lastSyncAt,
					autoDisabledReason: merged.autoDisabledReason,
					autoDisabledAt: merged.autoDisabledAt,
					isEnabled: merged.isEnabled,
					createdAt: row.createdAt.toISOString(),
					updatedAt: new Date().toISOString(),
				}
			})
		},

		async delete(input: {
			readonly tenantId: string
			readonly propertyId: string
			readonly channelId: string
		}): Promise<void> {
			await sql`
				DELETE FROM channelConnection
				WHERE tenantId = ${input.tenantId}
				  AND propertyId = ${input.propertyId}
				  AND channelId = ${input.channelId}
			`
		},
	}
}
