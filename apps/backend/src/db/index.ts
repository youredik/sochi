import { query } from '@ydbjs/query'
import { driver } from './driver.ts'

/**
 * Tagged-template SQL client.
 * Usage: `sql<[{ id: string }]>\`SELECT id FROM user WHERE email = ${email}\``
 *
 * Interpolated values are auto-bound as typed DECLARE parameters — no manual
 * placeholder management needed.
 *
 * Callers needing `YDBError` / `driver` directly import from `@ydbjs/error` and
 * `./driver.ts` respectively — no re-exports here to keep the module boundary narrow.
 *
 * Session pool (added in @ydbjs/query 6.1.0, 2026-04-23):
 *   - `maxSize` caps concurrent live YDB sessions. 50 is the library default;
 *     we keep it until we have real load data. On Yandex Managed YDB serverless,
 *     session creation is cheap but not free (~ms each), and per-operation
 *     create/destroy without pooling is what the 6.1.0 release explicitly fixes.
 *   - `waitQueueFactor: 8` → up to 400 queued waiters before `SessionPoolFullError`
 *     (fast failure under thundering herd, preferred over unbounded queue).
 *   - Idle sessions reuse LIFO for server-side plan cache warmth.
 */
export const sql = query(driver, {
	poolOptions: {
		maxSize: 50,
		waitQueueFactor: 8,
	},
})

export { closeDriver, driver, readyDriver } from './driver.ts'

/**
 * Detects YDB UNIQUE-key collision errors regardless of how the driver
 * surfaces them under load (M9.5 Phase B follow-up — eradicates
 * payment.repo U4 flake observed 2026-04-28).
 *
 * Empirical observations across runs:
 *   - Steady-state: `Error('Transaction failed.', { cause: YDBError(code=400120) })`
 *     where 400120 = PRECONDITION_FAILED with issue ERROR(2012) «Conflict
 *     with existing key».
 *   - Under parallel-write load (multiple concurrent createIntent на same
 *     idempotencyKey), driver may surface code=400110 (ABORTED) ИЛИ wrap
 *     the YDBError one extra level deep (cause.cause.code).
 *
 * Walks err.cause chain (max 4 levels) checking:
 *   - .code === 400120 OR .code === 400110
 *   - OR .message includes 'Conflict with existing key' OR 'PRECONDITION_FAILED'
 *
 * Conservative: returns false for unrelated errors. Use at every UPSERT
 * catch site that wants to translate UNIQUE-collision к domain error.
 */
export function isYdbUniqueConflict(err: unknown): boolean {
	let cur: unknown = err
	for (let depth = 0; depth < 4 && cur; depth++) {
		if (cur && typeof cur === 'object') {
			const c = cur as { code?: unknown; message?: unknown; cause?: unknown }
			if (c.code === 400120 || c.code === 400110) return true
			if (typeof c.message === 'string') {
				if (c.message.includes('Conflict with existing key')) return true
				if (c.message.includes('PRECONDITION_FAILED')) return true
			}
			cur = c.cause
		} else {
			return false
		}
	}
	return false
}
