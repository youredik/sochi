import { YDBError } from '@ydbjs/error'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../factory.ts'
import { DomainError } from './domain.ts'
import { HTTP_STATUS_MAP } from './http-mapping.ts'

/**
 * Shared error handler — mounted via `app.onError(onError)` in production and
 * reused in middleware/route tests that need domain-error → HTTP-status mapping.
 *
 * Precedence:
 *   1. `DomainError` → HTTP_STATUS_MAP[code] (409/422/404/…), JSON body
 *      `{ error: { code, message } }` + warn-level log.
 *   2. `YDBError` → 503 DB_ERROR (upstream, client may retry) + error log.
 *   3. `ZodError` → 500 INTERNAL (repo-row schema drift; user-input Zod errors
 *      never reach onError — they're rejected by zValidator middleware first).
 *   4. Anything else → 500 INTERNAL.
 *
 * Tests can mount this directly (see `middleware/idempotency.test.ts`) — no
 * need to boot the whole `app.ts` just to verify domain-error status codes.
 */
export function onError(err: Error, c: Context<AppEnv>) {
	if (err instanceof DomainError) {
		const status = HTTP_STATUS_MAP[err.code] ?? 500
		c.var.logger?.warn({ err, code: err.code, status }, 'domain error')
		return c.json({ error: { code: err.code, message: err.message } }, status)
	}
	if (err instanceof YDBError) {
		c.var.logger?.error({ err, ydbCode: err.code }, 'YDB error')
		return c.json({ error: { code: 'DB_ERROR', message: 'Database temporarily unavailable' } }, 503)
	}
	if (err instanceof z.ZodError) {
		c.var.logger?.error({ err: err.flatten() }, 'schema drift in repo row')
		return c.json({ error: { code: 'INTERNAL', message: 'Internal data shape mismatch' } }, 500)
	}
	c.var.logger?.error({ err }, 'unhandled error')
	return c.json({ error: { code: 'INTERNAL', message: 'Internal server error' } }, 500)
}
