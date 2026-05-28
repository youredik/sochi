/**
 * Round 10 P0-1 + P0-2 fix — env-gated idempotent seed для demo webhook loop.
 *
 * Round 14.6 refactor: core UPSERT logic relocated к `src/lib/demo-channel-
 * seed.ts` (production-safe; allows `auth.ts.afterCreateOrganization` to seed
 * per-org channel infra without violating `_demo/` import boundary). This
 * file retains:
 *   - Legacy `seedDemoChannelInfra` shim around the lib function
 *   - Audit-table reachability smoke-test (Round 13 / migration 0078)
 *     — мis _demo-specific because the audit repo lives под `_demo/`.
 *
 * Canon: `feedback_round_10_truthful_post_review_canon_2026_05_25.md` +
 *        `feedback_round_14_6_per_tenant_demo_canon_2026_05_28.md`.
 *
 * **Idempotency**: UPSERT semantics. Re-running seed на каждом boot — safe.
 * Cron `demo-refresh` (project_demo_strategy.md) tolerates this too.
 *
 * **Env-gate**: caller (app.ts) wraps в `if (env.APP_MODE !== 'production')`.
 * This module itself does NOT check APP_MODE — single responsibility.
 */

import { sql } from '../../db/index.ts'
import {
	seedDemoChannelInfraCore,
	type SeedDemoChannelInfraOptions,
} from '../../lib/demo-channel-seed.ts'
import { createMockOtaAuditRepo } from './mock-ota-server/shared/mock-ota-audit.repo.ts'

export type { SeedDemoChannelInfraOptions } from '../../lib/demo-channel-seed.ts'

/**
 * Idempotent seed for demo webhook receiver infrastructure +
 * mockOta audit table reachability smoke-test. The latter touches
 * tables once at boot via 0-arg countLastHours read → catches missing
 * migration или RLS misconfig at boot, not при first request.
 *
 * Returns counts + reachability flag so caller can log + assert
 * deterministic seed at boot. Throws on DB error (caller should NOT
 * mask — boot failure preferable to silent broken-demo state).
 */
export async function seedDemoChannelInfra(opts: SeedDemoChannelInfraOptions): Promise<{
	readonly secretsSeeded: number
	readonly connectionsSeeded: number
	readonly auditTablesReachable: boolean
}> {
	const { secretsSeeded, connectionsSeeded } = await seedDemoChannelInfraCore(opts)

	// Round 13 — verify mockOta audit tables reachable (migration 0078).
	const auditRepo = createMockOtaAuditRepo(sql)
	let auditTablesReachable = false
	try {
		await auditRepo.countLastHours({ tenantId: opts.tenantId, hours: 24, nowMs: Date.now() })
		auditTablesReachable = true
	} catch {
		// Tables missing OR migration 0078 not applied → log later; demo still
		// works via in-memory state.ts. Failure NOT fatal at boot.
		auditTablesReachable = false
	}

	return { secretsSeeded, connectionsSeeded, auditTablesReachable }
}
