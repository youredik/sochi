/**
 * Round 8 P1-4 — 109-ФЗ ст.22 24h compliance cliff monitor (TDD).
 *
 * Goal: cron handler scans `migrationRegistration` for rows that have been
 * pending for ≥(24h - thresholdHours), emits warn-log + ops-metric для
 * каждой row to give operators a 4-hour window to intervene before
 * штраф ст.18.9 КоАП (400-500к ₽) bites.
 *
 * Reference canon: `feedback_legal_round_5_corrections_canon_2026_05_23.md` —
 * ст.20 + ст.22 (24h SLA) + ст.18.9 КоАП штрафы.
 *
 * Anchor: `submittedAt` (когда transport pushArchive acked = row entered
 * pending-with-МВД processing). Safe statuses (excluded from alert):
 *   - 1 (registered, СМЭВ ack)
 *   - 2 (sent_to_authority, МВД ведомство receives)
 *   - 3/4/10 (FINAL: executed/refused/cancelled)
 *   - 17 (submitted, transport ack — task literal 'submitted')
 *
 * Alert states (still-in-flight): 5 (send_error), 9 (cancellation_pending),
 *   14 (awaiting_info), 15 (requires_correction), 21 (acknowledged),
 *   22 (delivery_error), 24 (processing_error).
 *
 * Test matrix (per task spec):
 *   [DM1] Row submitted 19h ago, status=21 → returned by getApproachingDeadline
 *   [DM2] Row submitted 23h59m ago, status=22 → returned (red zone)
 *   [DM3] Row submitted 5h ago, status=21 → NOT returned
 *   [DM4] Row submitted 19h ago, status=17 ('submitted') → NOT returned (safe)
 *   [DM5] Row submitted 19h ago, status=3 ('failed_permanent' = FINAL) → NOT returned
 *   [DM6] Row submitted 19h ago, status=1 ('accepted') → NOT returned
 *   [DM7] Boundary: exactly 20h ago + threshold=4 → returned (≥20h gate)
 *   [DM8] Boundary: 19h59m59s ago + threshold=4 → NOT returned (just-before)
 *   [DM9] threshold default = 4h (smoke test)
 *
 *   [CR1] runDeadlineCheck logs warn per row + emits ops-metric per row
 *   [CR2] runDeadlineCheck count metric increments cumulatively across calls
 *   [CR3] no rows → no warn-log, no metric emitted (silent on quiet cycles)
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { emitMigrationRegistrationDeadlineMetric, opsMetricsBuffer } from '../lib/ops-metrics.ts'
import {
	APPROACHING_DEADLINE_THRESHOLD_HOURS_DEFAULT,
	type DeadlineAlertRow,
	type DeadlineMonitorLogger,
	hoursUntilDeadlineToBucket,
	runMigrationDeadlineCheck,
} from './epgu-deadline-monitor.ts'

afterEach(() => {
	// Isolation — flush singleton buffer between tests.
	opsMetricsBuffer.drain()
})

function makeRow(overrides: Partial<DeadlineAlertRow> = {}): DeadlineAlertRow {
	return {
		tenantId: 'org-test',
		id: 'mreg-test-1',
		bookingId: 'book-test-1',
		statusCode: 21,
		submittedAt: new Date('2026-05-25T00:00:00Z'),
		...overrides,
	}
}

function makeMockLogger(): DeadlineMonitorLogger & {
	warnCalls: Array<{ obj: object; msg: string }>
	infoCalls: Array<{ obj: object; msg: string }>
} {
	const warnCalls: Array<{ obj: object; msg: string }> = []
	const infoCalls: Array<{ obj: object; msg: string }> = []
	return {
		warnCalls,
		infoCalls,
		warn: (obj: object, msg: string) => {
			warnCalls.push({ obj, msg })
		},
		info: (obj: object, msg: string) => {
			infoCalls.push({ obj, msg })
		},
	}
}

describe('epgu-deadline-monitor — runMigrationDeadlineCheck', () => {
	test('[CR1] each row → 1 warn-log + 1 ops-metric event', async () => {
		const log = makeMockLogger()
		const fixedNow = new Date('2026-05-25T20:00:00Z')
		const row = makeRow({
			submittedAt: new Date('2026-05-25T00:30:00Z'), // 19.5h ago
		})
		const fetchApproaching = mock().mockResolvedValue([row])
		const result = await runMigrationDeadlineCheck({
			fetchApproaching,
			log,
			now: () => fixedNow,
		})
		expect(result.alertCount).toBe(1)
		expect(log.warnCalls.length).toBe(1)
		const warnCall = log.warnCalls[0]
		expect(warnCall?.obj).toMatchObject({
			event: 'migration_registration.approaching_deadline',
			tenantId: 'org-test',
			bookingId: 'book-test-1',
		})
		// Hours until deadline must be exact-value asserted (not just defined).
		// 24h - 19.5h elapsed = 4.5h remaining
		const obj = warnCall?.obj as { hoursUntilDeadline: number }
		expect(obj.hoursUntilDeadline).toBeCloseTo(4.5, 1)
		// ops-metric emitted
		const events = opsMetricsBuffer.drain()
		expect(events.length).toBe(1)
		expect(events[0]?.name).toBe('migration_registration.approaching_deadline')
		expect(events[0]?.value).toBe(1)
	})

	test('[CR2] count metric increments across multiple rows in one cycle', async () => {
		const log = makeMockLogger()
		const fixedNow = new Date('2026-05-25T20:00:00Z')
		const rows = [
			makeRow({ id: 'mreg-1', submittedAt: new Date('2026-05-25T00:00:00Z') }),
			makeRow({ id: 'mreg-2', submittedAt: new Date('2026-05-24T23:30:00Z') }),
			makeRow({ id: 'mreg-3', submittedAt: new Date('2026-05-24T22:00:00Z') }),
		]
		const fetchApproaching = mock().mockResolvedValue(rows)
		const result = await runMigrationDeadlineCheck({
			fetchApproaching,
			log,
			now: () => fixedNow,
		})
		expect(result.alertCount).toBe(3)
		expect(log.warnCalls.length).toBe(3)
		const events = opsMetricsBuffer.drain()
		expect(events.length).toBe(3)
		expect(events.every((e) => e.name === 'migration_registration.approaching_deadline')).toBe(true)
	})

	test('[CR3] no rows → no warn, no metric (quiet cycle)', async () => {
		const log = makeMockLogger()
		const fetchApproaching = mock().mockResolvedValue([])
		const result = await runMigrationDeadlineCheck({
			fetchApproaching,
			log,
			now: () => new Date('2026-05-25T20:00:00Z'),
		})
		expect(result.alertCount).toBe(0)
		expect(log.warnCalls.length).toBe(0)
		const events = opsMetricsBuffer.drain()
		expect(events.length).toBe(0)
	})

	test('[CR4] hoursUntilDeadline computed deterministically from submittedAt + now', async () => {
		const log = makeMockLogger()
		const fixedNow = new Date('2026-05-25T22:00:00Z')
		// 23h elapsed → 1h until 24h cliff
		const row = makeRow({ submittedAt: new Date('2026-05-24T23:00:00Z') })
		await runMigrationDeadlineCheck({
			fetchApproaching: mock().mockResolvedValue([row]),
			log,
			now: () => fixedNow,
		})
		const obj = log.warnCalls[0]?.obj as { hoursUntilDeadline: number }
		expect(obj.hoursUntilDeadline).toBeCloseTo(1, 2)
	})

	test('[CR5] DEFAULT threshold constant exported = 4', () => {
		expect(APPROACHING_DEADLINE_THRESHOLD_HOURS_DEFAULT).toBe(4)
	})

	test('[CR6] negative hoursUntilDeadline (past 24h cliff) clamped reported as 0 but still alerts', async () => {
		const log = makeMockLogger()
		// 26h elapsed → already past 24h cliff; we still want to alert,
		// hoursUntilDeadline reports 0 (clamped, not negative — operator UX).
		const fixedNow = new Date('2026-05-26T02:00:00Z')
		const row = makeRow({ submittedAt: new Date('2026-05-25T00:00:00Z') })
		await runMigrationDeadlineCheck({
			fetchApproaching: mock().mockResolvedValue([row]),
			log,
			now: () => fixedNow,
		})
		const obj = log.warnCalls[0]?.obj as { hoursUntilDeadline: number }
		expect(obj.hoursUntilDeadline).toBe(0)
	})
})

describe('epgu-deadline-monitor — emitMigrationRegistrationDeadlineMetric helper', () => {
	test('canonical metric name + labels', () => {
		opsMetricsBuffer.drain()
		emitMigrationRegistrationDeadlineMetric({
			tenantId: 'org-test', // sanitized away (PII guard)
			hoursBucket: 'lt_2',
			value: 1,
		})
		const events = opsMetricsBuffer.drain()
		expect(events.length).toBe(1)
		expect(events[0]?.name).toBe('migration_registration.approaching_deadline')
		expect(events[0]?.value).toBe(1)
		// Low-cardinality labels only — no tenantId leak.
		const keys = Object.keys(events[0]?.labels ?? {}).sort()
		expect(keys).toEqual(['hoursBucket'])
		expect(events[0]?.labels.hoursBucket).toBe('lt_2')
	})

	test('hoursBucket from hoursUntilDeadline mapping — pure helper', () => {
		// Helper inside epgu-deadline-monitor — bucket converts hours → label.
		// Round 8 P1-4: keep cardinality low (4 buckets), excellent for alarms.
		expect(hoursUntilDeadlineToBucket(0)).toBe('lt_1')
		expect(hoursUntilDeadlineToBucket(0.5)).toBe('lt_1')
		expect(hoursUntilDeadlineToBucket(1)).toBe('lt_2')
		expect(hoursUntilDeadlineToBucket(1.9)).toBe('lt_2')
		expect(hoursUntilDeadlineToBucket(2)).toBe('lt_3')
		expect(hoursUntilDeadlineToBucket(2.5)).toBe('lt_3')
		expect(hoursUntilDeadlineToBucket(3)).toBe('lt_4')
		expect(hoursUntilDeadlineToBucket(3.99)).toBe('lt_4')
		expect(hoursUntilDeadlineToBucket(4)).toBe('lt_4') // boundary inclusive of 4
	})
})
