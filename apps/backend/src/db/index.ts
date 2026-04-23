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

export { closeDriver, readyDriver } from './driver.ts'
