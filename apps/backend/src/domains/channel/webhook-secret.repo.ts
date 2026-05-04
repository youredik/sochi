/**
 * Webhook secret repo — M10 / A7.1.fix (D25).
 *
 * Reads + rotates Standard Webhooks signature secrets per channel from
 * `webhookSecret` table (migration 0057).
 *
 * Lifecycle:
 *   - new key → INSERT с status='active'; existing 'active' → 'previous'
 *   - 48h grace → verifier accepts both 'active' AND 'previous' (Standard
 *     Webhooks multi-key canon)
 *   - after grace → flip 'previous' → 'expired' (cron / manual)
 *
 * Mock channels store `whsec_mock_*` dev-time stubs; sandbox/live read
 * encrypted secret from YC Lockbox by `credentialsLockboxRef` (stored in
 * `channelConnection`) and never persist в this table for non-Mock modes.
 */

import { randomBytes } from 'node:crypto'
import type { sql as SQL } from '../../db/index.ts'
import { NULL_TIMESTAMP, timestampOpt } from '../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

export type WebhookSecretStatus = 'active' | 'previous' | 'expired'

export interface WebhookSecretRow {
	readonly channelId: string
	readonly kid: string
	readonly secret: string
	readonly status: WebhookSecretStatus
	readonly activatedAt: string
	readonly expiresAt: string | null
}

type SecretYdbRow = {
	channelId: string
	kid: string
	secret: string
	status: string
	activatedAt: Date
	expiresAt: Date | null
}

function rowToSecret(r: SecretYdbRow): WebhookSecretRow {
	return {
		channelId: r.channelId,
		kid: r.kid,
		secret: r.secret,
		status: r.status as WebhookSecretStatus,
		activatedAt: r.activatedAt.toISOString(),
		expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
	}
}

/**
 * Generate `whsec_mock_<random>` dev-time stub. Standard Webhooks-compliant
 * shape (`whsec_` prefix, base64url payload). Used for Mock channels only.
 */
export function generateMockSecret(): string {
	return `whsec_mock_${randomBytes(24).toString('base64url')}`
}

export function createWebhookSecretRepo(sql: SqlInstance) {
	return {
		/**
		 * List ACCEPTED secrets for a channel (active + previous, ordered by
		 * activatedAt desc). Verifier walks this list trying each kid until
		 * signature matches OR all exhausted.
		 */
		async listAccepted(channelId: string): Promise<ReadonlyArray<WebhookSecretRow>> {
			const [rows = []] = await sql<SecretYdbRow[]>`
				SELECT channelId, kid, secret, status, activatedAt, expiresAt
				FROM webhookSecret
				WHERE channelId = ${channelId} AND (status = ${'active'} OR status = ${'previous'})
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			// Sort active-first, then by activatedAt desc.
			return rows.map(rowToSecret).sort((a, b) => {
				if (a.status !== b.status) return a.status === 'active' ? -1 : 1
				return b.activatedAt.localeCompare(a.activatedAt)
			})
		},

		async getByKid(input: {
			readonly channelId: string
			readonly kid: string
		}): Promise<WebhookSecretRow | null> {
			const [rows = []] = await sql<SecretYdbRow[]>`
				SELECT channelId, kid, secret, status, activatedAt, expiresAt
				FROM webhookSecret
				WHERE channelId = ${input.channelId} AND kid = ${input.kid}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToSecret(row) : null
		},

		/**
		 * Insert new active secret + flip existing 'active' → 'previous' inside
		 * Serializable tx (atomic rotation).
		 */
		async rotate(input: {
			readonly channelId: string
			readonly kid: string
			readonly secret: string
			readonly previousExpiresAtMs: number
		}): Promise<{ readonly demoted: number }> {
			return sql.begin(async (tx) => {
				const expiresAt = new Date(input.previousExpiresAtMs)
				const now = new Date()
				const [activeRows = []] = await tx<SecretYdbRow[]>`
					SELECT channelId, kid, secret, status, activatedAt, expiresAt
					FROM webhookSecret
					WHERE channelId = ${input.channelId} AND status = ${'active'}
				`
				for (const r of activeRows) {
					await tx`
						UPDATE webhookSecret
						SET status = ${'previous'}, expiresAt = ${timestampOpt(expiresAt)}
						WHERE channelId = ${r.channelId} AND kid = ${r.kid}
					`
				}
				await tx`
					INSERT INTO webhookSecret (channelId, kid, secret, status, activatedAt, expiresAt)
					VALUES (
						${input.channelId}, ${input.kid}, ${input.secret},
						${'active'}, ${now}, ${NULL_TIMESTAMP}
					)
				`
				return { demoted: activeRows.length }
			})
		},

		/**
		 * Move 'previous' rows whose expiresAt < now → 'expired'. Idempotent;
		 * called from cron OR manually. Returns count of expired rows.
		 */
		async expirePrevious(input: {
			readonly channelId: string
			readonly nowMs: number
		}): Promise<{ readonly expired: number }> {
			const cutoff = new Date(input.nowMs)
			const [rows = []] = await sql<SecretYdbRow[]>`
				SELECT channelId, kid, secret, status, activatedAt, expiresAt
				FROM webhookSecret
				WHERE channelId = ${input.channelId} AND status = ${'previous'}
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			let expired = 0
			for (const r of rows) {
				if (r.expiresAt !== null && r.expiresAt <= cutoff) {
					await sql`
						UPDATE webhookSecret
						SET status = ${'expired'}
						WHERE channelId = ${r.channelId} AND kid = ${r.kid}
					`
					expired++
				}
			}
			return { expired }
		},
	}
}
