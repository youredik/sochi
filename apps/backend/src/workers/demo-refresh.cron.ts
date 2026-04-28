/**
 * Demo refresh cron — periodically restores golden demo tenant state.
 *
 * Per `project_demo_strategy.md` (always-on demo product surface):
 *   - Demo tenants accumulate prospect mutations (test bookings, edits)
 *   - Cron resets к canonical seed state каждые 6 часов
 *   - Next prospect видит pristine demo, не мусор от previous session
 *
 * Lib: croner 10.x (DST-aware, overrun protection via `protect: true`).
 *
 * Catch-up на boot: runs once на startup чтобы demo был live сразу после
 * deploy. Skipped в test environment (NODE_ENV=test).
 */

import { Cron } from 'croner'
import type { sql as SQL } from '../db/index.ts'
import { runSeedDemoTenant } from '../db/seed-demo-tenant.ts'

type SqlInstance = typeof SQL

export interface DemoRefreshLogger {
	info: (data: object, msg: string) => void
	warn: (data: object, msg: string) => void
}

export interface DemoRefreshCronOptions {
	/** Cron expression. Default: every 6h at 0 minute. */
	schedule?: string
	/** Skip the immediate boot run (useful в tests / dev). */
	skipBootRun?: boolean
}

export function startDemoRefreshCron(
	_sql: SqlInstance,
	log: DemoRefreshLogger,
	opts: DemoRefreshCronOptions = {},
): { stop: () => Promise<void> } {
	const schedule = opts.schedule ?? '0 */6 * * *'
	let stopped = false

	const runOnce = async () => {
		if (stopped) return
		try {
			log.info({}, 'demo-refresh: starting golden state restore')
			const result = await runSeedDemoTenant()
			log.info({ tenantId: result.tenantId }, 'demo-refresh: golden state restored')
		} catch (err) {
			log.warn(
				{ err: err instanceof Error ? err.message : String(err) },
				'demo-refresh: failed (will retry next tick)',
			)
		}
	}

	const job = new Cron(schedule, { protect: true, paused: false }, runOnce)

	if (!opts.skipBootRun && process.env.NODE_ENV !== 'test') {
		// Boot catch-up: ensures demo tenant exists на startup сразу.
		void runOnce()
	}

	return {
		stop: async () => {
			stopped = true
			job.stop()
		},
	}
}
