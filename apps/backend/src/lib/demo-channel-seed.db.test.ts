/**
 * Round 14.6 — demo channel seed YDB integration tests.
 *
 * Exercises the production-safe `seedDemoChannelInfraCore` UPSERTs against
 * local YDB Docker. Empirically validates:
 *   - Idempotency (re-running seed yields same row count, no duplicates)
 *   - Cross-tenant isolation (orgA seed doesn't pollute orgB rows)
 *   - Both channels (YT + ETG) seeded by default
 *
 * Canon refs:
 *   - `feedback_deploy_as_debug_antipattern_2026_05_19` (local YDB Docker
 *     validation pre-push mandatory)
 *   - `feedback_critical_fix_test_coverage` (per-org seed branch coverage)
 *
 * Requires local YDB Docker (`docker-compose up ydb`) + migration 0050
 * (channelConnection) + 0057 (webhookSecret) applied.
 */
import { afterAll, beforeAll, describe, expect, jest, test } from 'bun:test'

jest.setTimeout(60_000)

import { getTestSql, setupTestDb, teardownTestDb } from '../tests/db-setup.ts'
import { demoPropertyIdForOrg, seedDemoChannelInfraCore } from './demo-channel-seed.ts'

const RUN_ID = Date.now().toString(36)
const TENANT_A = `org_demoseed_a_${RUN_ID}`
const TENANT_B = `org_demoseed_b_${RUN_ID}`
const WEBHOOK_SECRET = `whsec_demoseed_test_${RUN_ID}`

describe('seedDemoChannelInfraCore — YDB integration', () => {
	beforeAll(async () => {
		await setupTestDb()
	})

	afterAll(async () => {
		const sql = getTestSql()
		// Cleanup both tenants — webhookSecret PK = (channelId, kid), so we
		// need to identify our test rows by tenantId column.
		await sql`DELETE FROM webhookSecret WHERE tenantId = ${TENANT_A}`
		await sql`DELETE FROM webhookSecret WHERE tenantId = ${TENANT_B}`
		await sql`DELETE FROM channelConnection WHERE tenantId = ${TENANT_A}`
		await sql`DELETE FROM channelConnection WHERE tenantId = ${TENANT_B}`
		await teardownTestDb()
	})

	test('[DCS1] seeds 2 webhookSecret + 2 channelConnection rows for a fresh tenant', async () => {
		const result = await seedDemoChannelInfraCore({
			tenantId: TENANT_A,
			propertyId: demoPropertyIdForOrg(TENANT_A),
			webhookSecret: WEBHOOK_SECRET,
			sql: getTestSql(),
		})
		expect(result.secretsSeeded).toBe(2)
		expect(result.connectionsSeeded).toBe(2)

		const sql = getTestSql()
		const [secretRows = []] = await sql<{ channelId: string }[]>`
			SELECT channelId FROM webhookSecret WHERE tenantId = ${TENANT_A}
		`
		const secretChannels = secretRows.map((r) => r.channelId).sort()
		expect(secretChannels).toEqual(['ETG', 'YT'])

		const [connRows = []] = await sql<{ channelId: string; mode: string }[]>`
			SELECT channelId, mode FROM channelConnection WHERE tenantId = ${TENANT_A}
		`
		const connChannels = connRows.map((r) => r.channelId).sort()
		expect(connChannels).toEqual(['ETG', 'YT'])
		// All seeded connections are mock-mode (per Round 9 canon).
		expect(connRows.every((r) => r.mode === 'mock')).toBe(true)
	})

	test('[DCS2] idempotent — re-running seed для same tenant yields same row count', async () => {
		// First call done в DCS1. Second call should not create duplicates
		// (UPSERT semantics by PK = channelId + kid for secrets, tenantId +
		// propertyId + channelId for connections).
		await seedDemoChannelInfraCore({
			tenantId: TENANT_A,
			propertyId: demoPropertyIdForOrg(TENANT_A),
			webhookSecret: WEBHOOK_SECRET,
			sql: getTestSql(),
		})

		const sql = getTestSql()
		const [secretRows = []] = await sql<{ channelId: string }[]>`
			SELECT channelId FROM webhookSecret WHERE tenantId = ${TENANT_A}
		`
		expect(secretRows.length).toBe(2)
		const [connRows = []] = await sql<{ channelId: string }[]>`
			SELECT channelId FROM channelConnection WHERE tenantId = ${TENANT_A}
		`
		expect(connRows.length).toBe(2)
	})

	test('[DCS3] cross-tenant isolation — tenant B seed does NOT touch tenant A rows', async () => {
		const beforeASecrets = await getTestSql()<{ ch: string }[]>`
			SELECT channelId as ch FROM webhookSecret WHERE tenantId = ${TENANT_A}
		`
		const beforeACount = beforeASecrets[0]?.length ?? 0

		await seedDemoChannelInfraCore({
			tenantId: TENANT_B,
			propertyId: demoPropertyIdForOrg(TENANT_B),
			webhookSecret: WEBHOOK_SECRET,
			sql: getTestSql(),
		})

		const afterASecrets = await getTestSql()<{ ch: string }[]>`
			SELECT channelId as ch FROM webhookSecret WHERE tenantId = ${TENANT_A}
		`
		const afterACount = afterASecrets[0]?.length ?? 0
		expect(afterACount).toBe(beforeACount)

		const [bSecrets = []] = await getTestSql()<{ ch: string }[]>`
			SELECT channelId as ch FROM webhookSecret WHERE tenantId = ${TENANT_B}
		`
		expect(bSecrets.length).toBe(2)
	})

	test('[DCS4] channel set respected — пустой channels array seeds nothing', async () => {
		const result = await seedDemoChannelInfraCore({
			tenantId: TENANT_A,
			propertyId: demoPropertyIdForOrg(TENANT_A),
			webhookSecret: WEBHOOK_SECRET,
			channels: [],
			sql: getTestSql(),
		})
		expect(result.secretsSeeded).toBe(0)
		expect(result.connectionsSeeded).toBe(0)
	})

	test('[DCS5] partial channel set — only YT seeded', async () => {
		const TENANT_C = `org_demoseed_c_${RUN_ID}`
		const result = await seedDemoChannelInfraCore({
			tenantId: TENANT_C,
			propertyId: demoPropertyIdForOrg(TENANT_C),
			webhookSecret: WEBHOOK_SECRET,
			channels: ['YT'],
			sql: getTestSql(),
		})
		expect(result.secretsSeeded).toBe(1)
		expect(result.connectionsSeeded).toBe(1)

		const sql = getTestSql()
		const [rows = []] = await sql<{ channelId: string }[]>`
			SELECT channelId FROM channelConnection WHERE tenantId = ${TENANT_C}
		`
		expect(rows.length).toBe(1)
		expect(rows[0]?.channelId).toBe('YT')

		// Cleanup.
		await sql`DELETE FROM webhookSecret WHERE tenantId = ${TENANT_C}`
		await sql`DELETE FROM channelConnection WHERE tenantId = ${TENANT_C}`
	})
})
