/**
 * Tenant resolver — public widget URL slug → tenant id + demo/production mode.
 *
 * Used by public widget routes (no auth middleware) для маппинга
 * `/widget/{tenantSlug}` URL → internal `tenantId` за один SELECT.
 * Slug = `organization.slug` (Better Auth-managed, UNIQUE indexed).
 *
 * Per `plans/m9_widget_canonical.md` §M9.widget.1 + memory canonical:
 *   - Slug normalization: lowercase, trim, ASCII alphanumeric + dash
 *   - Unknown slug → null (route handler returns 404)
 *   - Returns `{ tenantId, mode }` so handler may gate behaviour для demo vs production
 */
import { sql } from '../db/index.ts'

export interface ResolvedTenant {
	readonly tenantId: string
	readonly slug: string
	readonly mode: 'demo' | 'production' | null
	readonly name: string
}

/**
 * Slug normalization — public widget URL canonical form.
 * Per Better Auth canonical: lowercase ASCII a-z 0-9 dash, 3-30 chars,
 * no leading/trailing dash. Single-char и double-char rejected.
 * Non-matching input returns null (route handler returns 404 NOT_FOUND).
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/

export function normalizeSlug(input: string): string | null {
	const trimmed = input.trim().toLowerCase()
	if (!SLUG_PATTERN.test(trimmed)) return null
	return trimmed
}

export async function resolveTenantBySlug(rawSlug: string): Promise<ResolvedTenant | null> {
	const slug = normalizeSlug(rawSlug)
	if (slug === null) return null
	const [rows = []] = await sql<{ id: string; slug: string; name: string; mode: string | null }[]>`
		SELECT o.id AS id, o.slug AS slug, o.name AS name, p.mode AS mode
		FROM organization AS o
		LEFT JOIN organizationProfile AS p ON p.organizationId = o.id
		WHERE o.slug = ${slug}
		LIMIT 1
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	const row = rows[0]
	if (!row) return null
	const mode = row.mode === 'demo' || row.mode === 'production' ? row.mode : null
	return { tenantId: row.id, slug: row.slug, name: row.name, mode }
}
