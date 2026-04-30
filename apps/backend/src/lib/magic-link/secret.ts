/**
 * Per-tenant magic-link signing secret resolver (M9.widget.5 — Track A3).
 *
 * Per `plans/m9_widget_5_canonical.md` §D3 + §7:
 *   - Phase 1: column-stored on `organizationProfile.magicLinkSecret`
 *     (32-byte cryptographically random, base64url-encoded).
 *   - Phase 2 (Track B5/Lockbox): replace со ссылкой на Lockbox secret ID.
 *
 * Bootstrap для existing tenants: `organizationProfile.magicLinkSecret = NULL`
 * after migration apply. Lazy back-fill on first read — `if (current == null) { generate + UPDATE; return generated; }`.
 * Idempotent: concurrent first-read race resolved через `UPDATE WHERE
 * magicLinkSecret IS NULL` semantic (loser overwrite OK — entropy identical).
 *
 * NOT exposed via REST — read-only resolver consumed by `magic-link.service.ts`.
 */

import { randomBytes } from 'node:crypto'
import type { sql as SQL } from '../../db/index.ts'

type SqlInstance = typeof SQL

/** 32 bytes = 256 bits HS256 secret. base64url for header-safe transport (Lockbox migration future). */
const SECRET_BYTES = 32

/** Generate fresh secret material — base64url-encoded for safe storage + transport. */
export function generateMagicLinkSecret(): string {
	return randomBytes(SECRET_BYTES).toString('base64url')
}

/**
 * Resolve per-tenant magic-link signing secret. Lazy-bootstraps если NULL
 * (existing tenants pre-dating migration 0045). Returns the secret string.
 *
 * Concurrent-call safety: race between two first-readers OK — both generate
 * + UPDATE, last-writer-wins; both secrets identical entropy так что even
 * если loser's UPDATE silently overwrites winner, it's not a security issue
 * (single-user account would not be affected, only would invalidate already-issued
 * JWTs — но first-read scenario means none issued yet).
 */
export function createMagicLinkSecretResolver(sql: SqlInstance) {
	return {
		async resolve(tenantId: string): Promise<string> {
			const [rows = []] = await sql<[{ magicLinkSecret: string | null }]>`
				SELECT magicLinkSecret
				FROM organizationProfile
				WHERE organizationId = ${tenantId}
				LIMIT 1
			`.idempotent(true)

			const existing = rows[0]?.magicLinkSecret
			if (existing) return existing

			// Lazy back-fill — generate + UPDATE WHERE current IS NULL.
			const fresh = generateMagicLinkSecret()
			await sql`
				UPDATE organizationProfile
				SET magicLinkSecret = ${fresh}
				WHERE organizationId = ${tenantId} AND magicLinkSecret IS NULL
			`.idempotent(true)

			// Re-read (handles race where another writer won + value differs).
			const [refreshed = []] = await sql<[{ magicLinkSecret: string | null }]>`
				SELECT magicLinkSecret FROM organizationProfile
				WHERE organizationId = ${tenantId} LIMIT 1
			`.idempotent(true)

			const final = refreshed[0]?.magicLinkSecret
			if (!final) {
				// organizationProfile row missing entirely (orphan org without profile).
				// Domain invariant: every org has profile (afterCreateOrganization hook
				// per existing canon). If missing — system error, not user-facing.
				throw new Error(
					`magicLinkSecret resolve failed: organizationProfile missing for org ${tenantId}`,
				)
			}
			return final
		},
	}
}

export type MagicLinkSecretResolver = ReturnType<typeof createMagicLinkSecretResolver>
