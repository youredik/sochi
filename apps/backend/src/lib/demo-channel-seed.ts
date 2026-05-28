/**
 * Round 14.6 — production-safe demo channel infra seed.
 *
 * UPSERTs `webhookSecret` + `channelConnection` rows для a given tenant +
 * property + channel set. Idempotent — safe to re-run at boot or per-org
 * creation hook.
 *
 * Why this file lives here (not in `_demo/`):
 *
 *   The original `_demo/seed.ts` was Round 10 boot-time wiring для legacy
 *   global `demo-tenant`. Round 14.6 strategic refactor makes демо OTA
 *   per-tenant — `auth.ts.afterCreateOrganization` hook seeds new orgs
 *   с свою копию demo channel infra. Production code MUST NOT import from
 *   `_demo/` (dependency-cruiser canon Round 9). The pure seed UPSERTs
 *   are not _demo-specific (they write production tables), so они
 *   relocate to production lib. `_demo/seed.ts` retains the audit-repo
 *   reachability smoke-test (which IS _demo-specific) and re-exports
 *   the core function через this module.
 *
 * Channel set: by default seeds 'YT' (Yandex.Путешествия) + 'ETG' (Островок).
 * Matches Round 9 mock-OTA wiring.
 */

import type { query } from '@ydbjs/query'
import { sql as productionSql } from '../db/index.ts'

export interface SeedDemoChannelInfraOptions {
	readonly tenantId: string
	readonly propertyId: string
	readonly webhookSecret: string
	/** Defaults к ['YT', 'ETG']. */
	readonly channels?: ReadonlyArray<'YT' | 'ETG'>
	/**
	 * Override the SQL client (DI hook для integration tests). Defaults к
	 * production `sql` from `db/index.ts`. Tests pass `getTestSql()` from
	 * `tests/db-setup.ts` to target local YDB Docker.
	 */
	readonly sql?: ReturnType<typeof query>
}

const DEFAULT_CHANNELS = ['YT', 'ETG'] as const
const LEGACY_DEMO_TENANT_ID = 'demo-tenant'
const LEGACY_DEMO_WEBHOOK_KID = 'kid_demo_v1'

/**
 * Round 14.6 — derive a per-tenant `kid` for the demo webhookSecret row.
 *
 * `webhookSecret` PK = (channelId, kid) — tenantId is informational (used by
 * Round 11 P1-B3 verification-time match). For per-tenant demos we cannot
 * share a single `kid_demo_v1` row — that would force all tenants onto the
 * same secret row, breaking isolation (last writer wins on tenantId column).
 *
 * Backwards-compat: the legacy `demo-tenant` (anonymous showcase) retains
 * the original `kid_demo_v1` kid so existing CloudEvents webhook signatures
 * verify против the same row. Other tenants get a deterministic per-org kid.
 */
export function demoWebhookKidForTenant(tenantId: string): string {
	if (tenantId === LEGACY_DEMO_TENANT_ID) {
		return LEGACY_DEMO_WEBHOOK_KID
	}
	return `kid_demo_${tenantId}`
}

/**
 * Idempotent UPSERT both `webhookSecret` and `channelConnection` rows для
 * the given (tenantId, propertyId) ⨯ channel set. Returns counts so
 * callers can log / observe deterministic seed.
 *
 * Throws on DB error (caller decides fail-soft / fail-loud).
 */
export async function seedDemoChannelInfraCore(
	opts: SeedDemoChannelInfraOptions,
): Promise<{ secretsSeeded: number; connectionsSeeded: number }> {
	const sql = opts.sql ?? productionSql
	const channels = opts.channels ?? DEFAULT_CHANNELS
	const now = new Date()
	const kid = demoWebhookKidForTenant(opts.tenantId)
	let secretsSeeded = 0
	let connectionsSeeded = 0

	for (const channelId of channels) {
		// webhookSecret PK = (channelId, kid); status='active' means receiver accepts.
		// Round 11 P1-B3 — bind secret к tenantId explicitly; cross-tenant URN
		// forgery rejected at signature-vs-row tenantId match.
		// Round 14.6 — `kid` is per-tenant (см. `demoWebhookKidForTenant`) so PK
		// scope provides empirical isolation across tenants (each org gets its
		// own webhookSecret row keyed by (channelId, `kid_demo_${orgId}`)).
		await sql`
			UPSERT INTO webhookSecret (
				\`channelId\`, \`kid\`, \`secret\`, \`status\`, \`activatedAt\`, \`tenantId\`
			) VALUES (
				${channelId}, ${kid}, ${opts.webhookSecret}, ${'active'}, ${now}, ${opts.tenantId}
			)
		`
		secretsSeeded++

		// channelConnection PK = (tenantId, propertyId, channelId); role='independent_operator'
		// per Round 8 canon (YT + ETG independent operators, not processors).
		// mode='mock' — demo flow uses Mock adapter even in cold-start.
		await sql`
			UPSERT INTO channelConnection (
				\`tenantId\`, \`propertyId\`, \`channelId\`,
				\`mode\`, \`role\`, \`syncStatus\`, \`isEnabled\`,
				\`createdAt\`, \`updatedAt\`
			) VALUES (
				${opts.tenantId}, ${opts.propertyId}, ${channelId},
				${'mock'}, ${'independent_operator'}, ${'idle'}, ${true},
				${now}, ${now}
			)
		`
		connectionsSeeded++
	}

	return { secretsSeeded, connectionsSeeded }
}

/**
 * Round 14.6 — derive a stable synthetic demo property ID for a given
 * organization. Used by `afterCreateOrganization` hook before the user
 * has created any real property (M5c setup wizard). The synthetic ID
 * scopes the demo `channelConnection` row per-tenant so that bookings
 * from per-tenant demo OTA land cleanly in the channelInbox without
 * colliding с real properties later created by the user.
 *
 * Shape: `demoprop_<orgId>` — deterministic from org.id (allows
 * idempotent UPSERT в any hook re-fire).
 */
export function demoPropertyIdForOrg(orgId: string): string {
	return `demoprop_${orgId}`
}
