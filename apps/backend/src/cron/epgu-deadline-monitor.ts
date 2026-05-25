/**
 * Round 8 P1-4 (2026-05-25) — 109-ФЗ ст.22 24h compliance cliff monitor.
 *
 * **Why this exists:**
 * 109-ФЗ от 18.07.2006 ст.22 (refined per `feedback_legal_round_5_corrections_canon_2026_05_23.md`):
 *   - Hotel must transmit guest data to МВД ГИС МУ within 1 рабочий день
 *     (24h) of arrival.
 *   - Failure to transmit = ст.18.9 КоАП → 400-500к ₽ штраф per row.
 *
 * **What this monitors:**
 * `migrationRegistration` rows that have been **pending** (i.e., still in
 * non-safe-state) for ≥(24h - thresholdHours). Default threshold = 4h, so
 * alert fires at 20h elapsed → operator has 4h window to intervene.
 *
 * **Safe-state set** (excluded from alert):
 *   - statusCode 1 (registered, СМЭВ accepted)
 *   - statusCode 2 (sent_to_authority, МВД ведомство received)
 *   - statusCode 3 (executed [FINAL])
 *   - statusCode 4 (refused [FINAL])
 *   - statusCode 10 (cancelled [FINAL])
 *   - statusCode 17 (submitted, transport pushArchive ack — task literal 'submitted')
 *
 * **Alert-eligible** (still in-flight): {0, 5, 9, 14, 15, 21, 22, 24}.
 *
 * **Surface:**
 *   - `logger.warn({event:'migration_registration.approaching_deadline', ...})`
 *     → YC Cloud Logging captures; alarms wired on this event-name pattern.
 *   - `opsMetricsBuffer.push('migration_registration.approaching_deadline')`
 *     → drained via `/api/internal/ops-metrics` Prometheus exposition →
 *     YC Cloud Monitoring scrape.
 *
 * **Anchor:** `submittedAt` (set when transport.pushArchive acked).
 * If `submittedAt IS NULL` → row never reached transport (different concern;
 * pre-submission stuck-in-draft path; separate alert TBD M9+).
 */

import { Cron } from 'croner'
import { emitMigrationRegistrationDeadlineMetric } from '../lib/ops-metrics.ts'

/** Default 4h window before 24h cliff = alert at 20h elapsed. */
export const APPROACHING_DEADLINE_THRESHOLD_HOURS_DEFAULT = 4

/**
 * Minimal row shape returned by repo `getApproachingDeadline` для cron handler
 * processing. Subset of full `MigrationRegistration` — keeps interface narrow
 * so test seam doesn't need every field.
 *
 * **submittedAt typing**: domain layer returns ISO-string ([[rowToDomain]] в
 * registration.repo.ts converts YDB Timestamp → ISO). Test seams pass Date
 * directly для convenience. Repo SQL filters `submittedAt IS NOT NULL` so
 * null should never appear at runtime — defensive type allows null + handler
 * skips defensively.
 */
export interface DeadlineAlertRow {
	readonly tenantId: string
	readonly id: string
	readonly bookingId: string
	readonly statusCode: number
	readonly submittedAt: string | Date | null
}

/**
 * Repo-fetch contract — test seam. Real impl backed by
 * `migrationRegistration.repo.getApproachingDeadline(now, threshold, limit)`.
 */
export type FetchApproachingDeadline = (
	now: Date,
	thresholdHours: number,
	limit: number,
) => Promise<readonly DeadlineAlertRow[]>

/** Minimal logger interface — accepts pino-shaped {obj, msg}. */
export interface DeadlineMonitorLogger {
	warn: (obj: object, msg: string) => void
	info: (obj: object, msg: string) => void
}

export interface RunDeadlineCheckInput {
	readonly fetchApproaching: FetchApproachingDeadline
	readonly log: DeadlineMonitorLogger
	readonly now?: () => Date
	readonly thresholdHours?: number
	/** Hard cap для one cron tick. Cron-internal; production batch=500. */
	readonly limit?: number
}

export interface RunDeadlineCheckResult {
	readonly alertCount: number
	readonly thresholdHours: number
	readonly scannedAtIso: string
}

/**
 * Bucket helper — converts `hoursUntilDeadline` к low-cardinality label.
 * 4 buckets = bounded label cardinality (canon: keep Prometheus label
 * cardinality bounded для cost-effective YC Cloud Monitoring).
 *
 * Mapping (interval semantic = strictly less than upper bound + closed bottom):
 *   [0, 1)  → 'lt_1'  (red — past 23h)
 *   [1, 2)  → 'lt_2'  (orange — past 22h)
 *   [2, 3)  → 'lt_3'  (yellow — past 21h)
 *   [3, ∞]  → 'lt_4'  (early-warning — past 20h)
 */
export function hoursUntilDeadlineToBucket(
	hoursUntilDeadline: number,
): 'lt_1' | 'lt_2' | 'lt_3' | 'lt_4' {
	if (hoursUntilDeadline < 1) return 'lt_1'
	if (hoursUntilDeadline < 2) return 'lt_2'
	if (hoursUntilDeadline < 3) return 'lt_3'
	return 'lt_4'
}

/**
 * Cron tick body — fetches approaching-deadline rows, emits warn-log +
 * ops-metric per row. Idempotent (each tick = independent snapshot scan).
 *
 * Returns count + threshold for caller logging / observability handle.
 *
 * Per `feedback_p1_means_now_not_later_canon_2026_05_23`: doesn't defer side
 * effects; emits ALL signals (log + metric) inline per row.
 */
export async function runMigrationDeadlineCheck(
	input: RunDeadlineCheckInput,
): Promise<RunDeadlineCheckResult> {
	const now = (input.now ?? (() => new Date()))()
	const thresholdHours = input.thresholdHours ?? APPROACHING_DEADLINE_THRESHOLD_HOURS_DEFAULT
	const limit = input.limit ?? 500

	const rows = await input.fetchApproaching(now, thresholdHours, limit)
	let alertCount = 0
	for (const row of rows) {
		if (row.submittedAt === null) {
			// Defensive — repo SQL filters NOT NULL, but type allows null per
			// domain layer. Skip silently rather than misclassify hoursUntilDeadline.
			continue
		}
		const submittedAt =
			row.submittedAt instanceof Date ? row.submittedAt : new Date(row.submittedAt)
		// Compute hoursUntilDeadline: (24h - elapsedHours). Clamp к 0
		// для UX — operator-facing log "0 hours left" rather than negative.
		const elapsedMs = now.getTime() - submittedAt.getTime()
		const elapsedHours = elapsedMs / (60 * 60 * 1000)
		const rawHoursUntilDeadline = 24 - elapsedHours
		const hoursUntilDeadline = Math.max(0, rawHoursUntilDeadline)
		const hoursBucket = hoursUntilDeadlineToBucket(hoursUntilDeadline)

		input.log.warn(
			{
				event: 'migration_registration.approaching_deadline',
				tenantId: row.tenantId,
				id: row.id,
				bookingId: row.bookingId,
				statusCode: row.statusCode,
				submittedAt: submittedAt.toISOString(),
				hoursUntilDeadline,
				hoursBucket,
				thresholdHours,
			},
			'109-ФЗ ст.22 cliff approaching — операторское вмешательство в течение thresholdHours до штрафа ст.18.9 КоАП',
		)

		emitMigrationRegistrationDeadlineMetric({
			tenantId: row.tenantId,
			hoursBucket,
			value: 1,
		})
		alertCount++
	}

	return {
		alertCount,
		thresholdHours,
		scannedAtIso: now.toISOString(),
	}
}

/**
 * Croner-based scheduled wrapper. Runs `runMigrationDeadlineCheck` every 5
 * minutes (default; configurable via opts.schedule) — fast enough к 4-hour
 * window к не miss the cliff, slow enough к не spam YDB. NODE_ENV=test
 * skips boot run + cron schedule (tests invoke handler directly).
 *
 * Per `feedback_yandex_cloud_only.md` + `project_yc_serverless_deploy_canon_2026_05_19.md`:
 * production carry-forward к YC Cloud Timer external trigger; in-process
 * Croner ok for Sprint C → М11 sweep.
 */
export interface StartMigrationDeadlineMonitorOptions {
	/** Cron expression. Default `*\/5 * * * *` — every 5 минут. */
	readonly schedule?: string
	/** Skip immediate boot run (tests / dev). */
	readonly skipBootRun?: boolean
	/** Override threshold (hours). Default = APPROACHING_DEADLINE_THRESHOLD_HOURS_DEFAULT. */
	readonly thresholdHours?: number
	/** Hard cap per-tick scan size. Default = 500. */
	readonly limit?: number
}

export interface StartMigrationDeadlineMonitorDeps {
	readonly fetchApproaching: FetchApproachingDeadline
	readonly log: DeadlineMonitorLogger
}

export function startMigrationDeadlineMonitor(
	deps: StartMigrationDeadlineMonitorDeps,
	opts: StartMigrationDeadlineMonitorOptions = {},
): { stop: () => Promise<void> } {
	// '*/5 * * * *' = top of every 5 минут. Croner-canon, identical к
	// notification-cron.ts pattern.
	const schedule = opts.schedule ?? '*/5 * * * *'
	let stopped = false

	const runOnce = async () => {
		if (stopped) return
		try {
			// exactOptionalPropertyTypes: spread only defined keys to avoid
			// `undefined` vs missing distinction (canon-locked в tsconfig.base.json).
			const result = await runMigrationDeadlineCheck({
				fetchApproaching: deps.fetchApproaching,
				log: deps.log,
				...(opts.thresholdHours !== undefined ? { thresholdHours: opts.thresholdHours } : {}),
				...(opts.limit !== undefined ? { limit: opts.limit } : {}),
			})
			if (result.alertCount > 0) {
				deps.log.info(
					{
						event: 'migration_registration.deadline_check.complete',
						alertCount: result.alertCount,
						thresholdHours: result.thresholdHours,
						scannedAt: result.scannedAtIso,
					},
					'109-ФЗ deadline check: alerts emitted',
				)
			}
		} catch (err) {
			deps.log.warn(
				{ err: err instanceof Error ? err.message : String(err) },
				'epgu-deadline-monitor: tick failed (will retry next cycle)',
			)
		}
	}

	const job = new Cron(schedule, { protect: true, paused: false }, runOnce)

	if (!opts.skipBootRun && process.env.NODE_ENV !== 'test') {
		// Catch-up boot tick: pick up any rows already past 20h on startup.
		void runOnce()
	}

	return {
		stop: async () => {
			stopped = true
			job.stop()
		},
	}
}
