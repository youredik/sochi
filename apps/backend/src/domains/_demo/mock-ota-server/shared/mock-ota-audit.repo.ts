/**
 * Round 13 — mockOta audit trail repo (canon closure).
 *
 * Round 9 canon claimed «triple defense» включая YDB TTL P1D on `mockOta_*`
 * tables. Round 10 P0-b honest-corrected: tables never existed. Round 13
 * creates them (migration 0078) и wires this thin repo so mock-OTA routes
 * INSERT audit rows on every fired demo CloudEvent. TTL P1D auto-cleans.
 *
 * Design — write-only from mock-OTA routes, no read endpoints (would expose
 * reserved-test-PII shape via auth-less debug surface). Operational read =
 * direct YDB query при triage.
 */

import { sql as SQL } from '../../../../db/index.ts'

type SqlInstance = typeof SQL

export interface MockOtaAuditRow {
	readonly tenantId: string
	readonly channelId: 'YT' | 'ETG'
	readonly mockOrderId: string
	readonly receivedAt: Date
	readonly payloadJson: unknown
	readonly correlatedEventId?: string | null
}

export function createMockOtaAuditRepo(sql: SqlInstance) {
	return {
		/**
		 * Insert audit row для demo CloudEvent fired к own webhook receiver.
		 * Idempotent on PK (tenantId, channelId, mockOrderId) — duplicate
		 * calls (replay) UPSERT, не error.
		 */
		async recordReservation(row: MockOtaAuditRow): Promise<void> {
			await sql`
				UPSERT INTO mockOtaReservationAudit (
					\`tenantId\`, \`channelId\`, \`mockOrderId\`,
					\`receivedAt\`, \`payloadJson\`, \`correlatedEventId\`
				) VALUES (
					${row.tenantId}, ${row.channelId}, ${row.mockOrderId},
					${row.receivedAt}, ${JSON.stringify(row.payloadJson)},
					${row.correlatedEventId ?? null}
				)
			`
		},

		/**
		 * Operational read — count audit rows last N hours. Used by ops
		 * dashboard / smoke tests. No PII exposed (count only).
		 */
		async countLastHours(input: {
			readonly tenantId: string
			readonly hours: number
			readonly nowMs?: number
		}): Promise<{ readonly count: bigint }> {
			const cutoff = new Date((input.nowMs ?? Date.now()) - input.hours * 60 * 60 * 1000)
			const [rows = []] = await sql<{ cnt: bigint }[]>`
				SELECT COUNT(*) AS cnt FROM mockOtaReservationAudit
				WHERE tenantId = ${input.tenantId} AND receivedAt > ${cutoff}
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const first = rows[0]
			return { count: first?.cnt ?? 0n }
		},
	}
}
