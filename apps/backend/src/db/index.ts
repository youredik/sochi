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
 */
export const sql = query(driver)

export { closeDriver, readyDriver } from './driver.ts'
