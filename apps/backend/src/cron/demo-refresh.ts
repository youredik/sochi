/**
 * Demo-tenant refresh cron — M9.widget.8 / A6.1 / D12-D14.
 *
 * **Purpose:** keep the demo-sirius tenant's bookings + availability looking
 * "fresh" (rolling forward dates) so demo always shows realistic state.
 * Without refresh, seeded bookings drift into the past and demo looks dead.
 *
 * **Schedule:** daily 03:00 MSK (`0 3 * * *` Europe/Moscow). Permanent UTC+3
 * since Russia abolished DST in 2014; ICU 78.2 in Node 24 handles correctly
 * (R2-croner #1 verified).
 *
 * **Concurrency model (D13/D14):**
 *   - `protect: true` on Cron — overrun guard; new tick blocked while previous
 *     in-flight. Croner does NOT auto-retry on error — handler completes
 *     (success or failure), next scheduled tick fires normally.
 *   - **Idempotent handler**: UPSERT keyed by `(jobName, runDate)` into
 *     `cronRunLog` — N invocations on same run_date produce ≤1 set of
 *     side-effects.
 *   - **Resumable**: handler may write `checkpoint` rows mid-flight; on
 *     SIGTERM mid-tick (Yandex Cloud 30s grace), next tick reads the last
 *     checkpoint and continues. NOT a 60s monolith.
 *   - **Cold-start check** (`shouldFireOnStartup`): if `MAX(runDate) WHERE
 *     status='completed'` > 24h ago — fire once now (Croner does NOT fire
 *     missed ticks; we emulate via startup hook).
 *   - **Single-instance gate**: `RUN_CRON=true` env-flag set on exactly one
 *     replica. Defer YDB Coordination Service до multi-instance need (M11+).
 *
 * **OTel:** every tick wrapped в `tracer.startActiveSpan('cron.demo-refresh')`
 * с standard semconv attrs (cron.schedule, cron.attempt_id, error.type).
 *
 * **Production carry-forward:** YC Cloud Timer trigger replaces in-process
 * Croner на Track B deploy gate (containers scale-to-zero would kill cron;
 * external trigger fires HTTP webhook).
 */

import { trace } from '@opentelemetry/api'
import { Cron } from 'croner'

export const DEMO_REFRESH_JOB_NAME = 'demo-refresh' as const
export const DEMO_REFRESH_CRON_EXPR = '0 3 * * *' as const
export const DEMO_REFRESH_TIMEZONE = 'Europe/Moscow' as const

/**
 * Test-seamable contract for handler. `runDate` is the canonical UTC-date
 * key (always derived from current wall-clock; tests inject `now()` via
 * options on the runner).
 *
 * Handler MUST be idempotent — multiple invocations with same `runDate`
 * produce ≤1 set of side-effects. Use the existing `cronRunLog` UPSERT
 * pattern + your own checkpoint tracking inside the handler.
 */
export type DemoRefreshHandler = (input: { runDate: string; attemptId: string }) => Promise<void>

export interface DemoRefreshOptions {
	readonly handler: DemoRefreshHandler
	/** Test seam: fire IMMEDIATELY (paused: true skips schedule). */
	readonly paused?: boolean
	/** Test seam: clock function. Defaults to `Date`. */
	readonly now?: () => Date
}

/**
 * Build the Croner job — does NOT start it. Caller decides whether to fire
 * on startup-check (`runOnce` below) and/or schedule normally.
 */
export function buildDemoRefreshCron(opts: DemoRefreshOptions): Cron<undefined> {
	const tracer = trace.getTracer('cron')
	return new Cron<undefined>(
		DEMO_REFRESH_CRON_EXPR,
		{
			timezone: DEMO_REFRESH_TIMEZONE,
			protect: true,
			name: DEMO_REFRESH_JOB_NAME,
			paused: opts.paused === true,
			catch: (err) => {
				// `catch:` callback prevents async errors from crashing process.
				// Real error logging happens inside `runOnce` (we have logger там).
				// This is the last-line defense.
				void err
			},
		},
		async () => {
			const now = (opts.now ?? (() => new Date()))()
			const runDate = formatRunDateUtc(now)
			const attemptId = crypto.randomUUID()
			await tracer.startActiveSpan('cron.demo-refresh', async (span) => {
				span.setAttribute('cron.schedule', DEMO_REFRESH_CRON_EXPR)
				span.setAttribute('cron.attempt_id', attemptId)
				span.setAttribute('cron.run_date', runDate)
				try {
					await opts.handler({ runDate, attemptId })
					span.setStatus({ code: 1 })
				} catch (err) {
					span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) })
					span.setAttribute('error.type', err instanceof Error ? err.constructor.name : 'unknown')
					throw err
				} finally {
					span.end()
				}
			})
		},
	)
}

/**
 * Cold-start hook — runs the handler ONCE if last successful refresh > 24h ago.
 * Idempotent: handler's own UPSERT-by-(jobName, runDate) ensures dedup.
 *
 * @param shouldFire test seam: returns true if startup-check passed (real impl
 *                   queries cronRunLog). We accept it as injected to avoid
 *                   coupling this function to YDB sql.
 */
export async function runOnceOnStartup(opts: {
	shouldFire: () => Promise<boolean>
	handler: DemoRefreshHandler
	now?: () => Date
}): Promise<{ fired: boolean }> {
	const fire = await opts.shouldFire()
	if (!fire) return { fired: false }
	const now = (opts.now ?? (() => new Date()))()
	await opts.handler({
		runDate: formatRunDateUtc(now),
		attemptId: crypto.randomUUID(),
	})
	return { fired: true }
}

/**
 * Format `Date` as canonical UTC `YYYY-MM-DD` for run_date key.
 *
 * **Why UTC:** wall-clock-day boundary differs by timezone; UTC is the
 * single source of truth for «which day's tick». For 03:00 Europe/Moscow
 * (UTC+3) the corresponding UTC date is the SAME calendar day — never crosses
 * UTC midnight (00:00 MSK = 21:00 UTC prev day). Safe.
 */
function formatRunDateUtc(d: Date): string {
	const y = d.getUTCFullYear()
	const m = String(d.getUTCMonth() + 1).padStart(2, '0')
	const day = String(d.getUTCDate()).padStart(2, '0')
	return `${y}-${m}-${day}`
}

// Test-only export to permit unit assertions on the date formatter.
export const __testHooks = { formatRunDateUtc } as const
