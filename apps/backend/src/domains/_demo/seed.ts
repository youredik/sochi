/**
 * Round 10 P0-1 + P0-2 fix — env-gated idempotent seed для demo webhook loop.
 *
 * Canon: `feedback_round_10_truthful_post_review_canon_2026_05_25.md`.
 *
 * **Problem solved**: до Round 10 demo webhook loop был broken в cold-start —
 * mock-OTA fired CloudEvents webhook к own `/api/channel/webhooks/{channel}`,
 * но receiver проверял webhookSecret table (Round 8 P1-6) → no rows → 401.
 * Затем проверял connectionRepo.listByTenant('demo-tenant') → no rows → 403.
 * E2E spec проходил из-за fetch-mock, real curl failed.
 *
 * **This module fixes both**: at backend boot (когда APP_MODE !== production)
 * вызывается `seedDemoChannelInfra` который idempotently UPSERTs:
 *   - webhookSecret(channelId='YT', kid='kid_demo_v1', secret=<from-opts>, status='active')
 *   - webhookSecret(channelId='ETG', ...) mirror
 *   - channelConnection(tenantId='demo-tenant', propertyId='demo-hotel-sochi', channelId='YT', mode='mock', isEnabled=true)
 *   - channelConnection(... ETG mirror)
 *
 * **Idempotency**: UPSERT semantics. Re-running seed на каждом boot — safe.
 * Cron `demo-refresh` (project_demo_strategy.md) tolerates this too.
 *
 * **Env-gate**: caller (app.ts) wraps в `if (env.APP_MODE !== 'production')`.
 * This module itself does NOT check APP_MODE — single responsibility.
 */

import { sql } from '../../db/index.ts'

export interface SeedDemoChannelInfraOptions {
	readonly tenantId: string
	readonly propertyId: string
	readonly webhookSecret: string
	/** Both YT and ETG channels are seeded; opt-out parameter если future нужно. */
	readonly channels?: ReadonlyArray<'YT' | 'ETG'>
}

const DEFAULT_CHANNELS = ['YT', 'ETG'] as const
const DEMO_WEBHOOK_KID = 'kid_demo_v1'

/**
 * Idempotent seed for demo webhook receiver infrastructure.
 *
 * Returns counts so caller can log + assert deterministic seed at boot.
 * Throws на DB error (caller should NOT mask — boot failure preferable to
 * silent broken-demo state).
 */
export async function seedDemoChannelInfra(opts: SeedDemoChannelInfraOptions): Promise<{
	readonly secretsSeeded: number
	readonly connectionsSeeded: number
}> {
	const channels = opts.channels ?? DEFAULT_CHANNELS
	const now = new Date()
	let secretsSeeded = 0
	let connectionsSeeded = 0

	for (const channelId of channels) {
		// webhookSecret: PK=(channelId, kid); status='active' means receiver accepts.
		// Round 11 P1-B3 — bind secret к demo-tenant explicitly (migration 0077).
		// Cross-tenant URN forgery now rejected at signature-vs-row tenantId match.
		await sql`
			UPSERT INTO webhookSecret (
				\`channelId\`, \`kid\`, \`secret\`, \`status\`, \`activatedAt\`, \`tenantId\`
			) VALUES (
				${channelId}, ${DEMO_WEBHOOK_KID}, ${opts.webhookSecret}, ${'active'}, ${now}, ${opts.tenantId}
			)
		`
		secretsSeeded++

		// channelConnection: PK=(tenantId, propertyId, channelId); role='independent_operator'
		// per Round 8 canon (YT + ETG are independent operators, not processors).
		// mode='mock' — Round 9 demo flow uses Mock adapter even в cold-start.
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
