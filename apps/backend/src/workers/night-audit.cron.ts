/**
 * Night-audit cron wrapper — schedules `runNightAudit` daily at 03:00
 * Europe/Moscow + does a catch-up pass on boot.
 *
 * Lib choice: `croner` 10.x (DST-aware, overrun protection via `protect: true`,
 * TypeScript-native). Replaces older `node-cron` per 2026 research synthesis.
 *
 * **Catch-up on boot**: a server restart during the audit window (e.g. 03:00–
 * 03:05 MSK) would silently skip a night. Mitigation: on boot we run the
 * audit once with `now = new Date()`, which posts any nights deterministically
 * skipped by the prior process (idempotent by line PK).
 *
 * **Why not BullMQ/Redis**: one job. UNIQUE PK on folioLine.id provides
 * exactly-once at the row level. Single-instance assumption is documented; if
 * we ever scale to N replicas, add a lease row in `night_audit_run` keyed by
 * `(propertyId, businessDate)` for leader election.
 *
 * Disabled in tests via `NODE_ENV=test` — integration tests call `runNightAudit`
 * directly with controlled `now`.
 */

import { Cron } from 'croner'
import type { sql as SQL } from '../db/index.ts'
import { type AuditLogger, runNightAudit } from './night-audit.ts'

type SqlInstance = typeof SQL

export interface NightAuditCronOptions {
	/** Cron expression. Default: 03:00 daily. */
	schedule?: string
	/** Cutoff hour MSK (default 3 = 03:00). */
	cutoffHourMsk?: number
	/** Skip the immediate boot catch-up run (useful in dev). */
	skipBootRun?: boolean
}

export function startNightAuditCron(
	sql: SqlInstance,
	log: AuditLogger,
	opts: NightAuditCronOptions = {},
): { stop: () => Promise<void> } {
	const schedule = opts.schedule ?? '0 3 * * *'
	const cutoffHourMsk = opts.cutoffHourMsk ?? 3

	const job = new Cron(
		schedule,
		{
			timezone: 'Europe/Moscow',
			protect: true, // skip a fire if previous still running (overrun guard)
			catch: (err) => {
				log.error({ err }, 'night-audit: cron handler threw — see prior log lines for context')
			},
		},
		async () => {
			await runNightAudit(sql, log, { cutoffHourMsk })
		},
	)
	log.info(
		{ schedule, timezone: 'Europe/Moscow', cutoffHourMsk, nextRun: job.nextRun()?.toISOString() },
		'night-audit: cron scheduled',
	)

	// Boot catch-up — handle restart-during-audit-window gap.
	if (!opts.skipBootRun) {
		runNightAudit(sql, log, { cutoffHourMsk }).catch((err) => {
			log.error({ err }, 'night-audit: boot catch-up failed')
		})
	}

	return {
		stop: async () => {
			job.stop()
			log.info({}, 'night-audit: cron stopped')
		},
	}
}
