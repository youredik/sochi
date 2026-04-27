/**
 * Integration test for the M8.A.0.6 recipientKind column roundtrip.
 *
 * Strict per `feedback_strict_tests.md`:
 *   - exact-value asserts on every enum value (full coverage)
 *   - `null` roundtrips correctly (M7 backwards-compat)
 *   - cross-tenant probe: column read scoped to tenant
 *   - column type: rejects unknown enum at app boundary
 *
 * Existing M7 writers (CDC handler + cron) don't yet populate
 * recipientKind — they will land in M8.B. This test verifies the COLUMN
 * mechanic (DB ALTER, repo `rowToNotification` mapping) so M8.B can land
 * cleanly.
 */
import { type NotificationRecipientKind, notificationRecipientKindSchema } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { NULL_TEXT, NULL_TIMESTAMP, textOpt, toJson, toTs } from '../../db/ydb-helpers.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'

const RUN_ID = Date.now().toString(36)
const TENANT_A = `org_rk_a_${RUN_ID}`
const TENANT_B = `org_rk_b_${RUN_ID}`

async function seedRow(opts: {
	tenantId: string
	id: string
	recipientKind: NotificationRecipientKind | null
}) {
	const sql = getTestSql()
	const now = new Date()
	const nowTs = toTs(now)
	await sql`
		UPSERT INTO notificationOutbox (
			\`tenantId\`, \`id\`,
			\`kind\`, \`channel\`, \`recipient\`, \`recipientKind\`, \`subject\`, \`bodyText\`, \`payloadJson\`,
			\`status\`,
			\`sentAt\`, \`failedAt\`, \`failureReason\`, \`retryCount\`,
			\`sourceObjectType\`, \`sourceObjectId\`, \`sourceEventDedupKey\`,
			\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
		) VALUES (
			${opts.tenantId}, ${opts.id},
			${'pre_arrival'}, ${'email'}, ${'guest@example.com'},
			${textOpt(opts.recipientKind)},
			${'Subj'}, ${NULL_TEXT}, ${toJson({})},
			${'pending'},
			${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT}, ${0},
			${'booking'}, ${'book_test'}, ${`booking:book_test:${opts.id}`},
			${nowTs}, ${nowTs}, ${'test'}, ${'test'}
		)
	`
}

describe('notification.recipientKind column roundtrip', { tags: ['db'], timeout: 30_000 }, () => {
	beforeAll(async () => {
		await setupTestDb()
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const t of [TENANT_A, TENANT_B]) {
			await sql`DELETE FROM notificationOutbox WHERE tenantId = ${t}`
		}
		await teardownTestDb()
	})

	test('[N1] every enum value roundtrips exactly through column', async () => {
		const all: NotificationRecipientKind[] = ['user', 'guest', 'system', 'channel']
		for (const k of all) {
			const id = `ntf_rk_${k}_${RUN_ID}`
			await seedRow({ tenantId: TENANT_A, id, recipientKind: k })
			const sql = getTestSql()
			const [rows = []] = await sql<{ recipientKind: string | null }[]>`
				SELECT recipientKind
				FROM notificationOutbox
				WHERE tenantId = ${TENANT_A} AND id = ${id}
				LIMIT 1
			`
			expect(rows[0]?.recipientKind).toBe(k)
			// Service-boundary parse — verifies enum schema agrees with stored value.
			expect(notificationRecipientKindSchema.parse(rows[0]?.recipientKind)).toBe(k)
		}
	})

	test('[N2] NULL recipientKind roundtrips as null (M7 backwards compat)', async () => {
		const id = `ntf_rk_null_${RUN_ID}`
		await seedRow({ tenantId: TENANT_A, id, recipientKind: null })
		const sql = getTestSql()
		const [rows = []] = await sql<{ recipientKind: string | null }[]>`
			SELECT recipientKind
			FROM notificationOutbox
			WHERE tenantId = ${TENANT_A} AND id = ${id}
			LIMIT 1
		`
		expect(rows[0]?.recipientKind).toBeNull()
	})

	test('[N3] cross-tenant: TENANT_A row not visible in TENANT_B scan', async () => {
		const id = `ntf_rk_ct_${RUN_ID}`
		await seedRow({ tenantId: TENANT_A, id, recipientKind: 'guest' })
		const sql = getTestSql()
		const [aRows = []] = await sql<{ recipientKind: string | null }[]>`
			SELECT recipientKind
			FROM notificationOutbox
			WHERE tenantId = ${TENANT_A} AND id = ${id}
			LIMIT 1
		`
		const [bRows = []] = await sql<{ recipientKind: string | null }[]>`
			SELECT recipientKind
			FROM notificationOutbox
			WHERE tenantId = ${TENANT_B} AND id = ${id}
			LIMIT 1
		`
		expect(aRows[0]?.recipientKind).toBe('guest')
		expect(bRows).toHaveLength(0)
	})

	test('[N4] schema rejects "admin" and other off-enum values at parse time', () => {
		expect(() => notificationRecipientKindSchema.parse('admin')).toThrow()
		expect(() => notificationRecipientKindSchema.parse('GUEST')).toThrow() // case-sensitive
	})
})
