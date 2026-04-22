import { query } from '@ydbjs/query'
import { driver } from './driver.ts'

/**
 * Tagged-template SQL client.
 * Usage: `sql<[{ id: string }]>\`SELECT id FROM user WHERE email = ${email}\``
 *
 * Interpolated values are auto-bound as typed DECLARE parameters — no manual
 * placeholder management needed.
 */
export const sql = query(driver)

export { YDBError } from '@ydbjs/error'
export { closeDriver, driver, readyDriver } from './driver.ts'
