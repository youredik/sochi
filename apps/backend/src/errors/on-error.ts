import { YDBError } from '@ydbjs/error'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { AppEnv } from '../factory.ts'
import { DomainError } from './domain.ts'
import { HTTP_STATUS_MAP } from './http-mapping.ts'

/**
 * Shared error handler — mounted via `app.onError(onError)` in production and
 * reused in middleware/route tests that need domain-error → HTTP-status mapping.
 *
 * Precedence:
 *   1. `HTTPException` → пропускаем through underlying response (Hono canonical
 *      throw mechanism — `bodyLimit`, manual `throw new HTTPException(413)`, etc.).
 *      Round 14.6.4 fix 2026-05-29: pre-fix this branch ABSENT → bodyLimit 64 KB
 *      cap silently degraded to 500 INTERNAL на проде because `app.onError` caught
 *      `HTTPException` and dropped к the fallback. Empirically caught когда
 *      `curl --data $(printf 'a%.0s' {1..100000}) https://demo.sepshn.ru/api/_mock-ota/yandex/v1/search`
 *      returned HTTP 500, не 413. **Defense-in-depth restored.**
 *   2. `DomainError` → HTTP_STATUS_MAP[code] (409/422/404/…), JSON body
 *      `{ error: { code, message } }` + warn-level log.
 *   3. `YDBError` → 503 DB_ERROR (upstream, client may retry) + error log.
 *   4. `ZodError` → 500 INTERNAL (repo-row schema drift; user-input Zod errors
 *      never reach onError — they're rejected by zValidator middleware first).
 *   5. Anything else → 500 INTERNAL.
 *
 * Tests can mount this directly (see `middleware/idempotency.test.ts`) — no
 * need to boot the whole `app.ts` just to verify domain-error status codes.
 */
export function onError(err: Error, c: Context<AppEnv>) {
	if (err instanceof HTTPException) {
		// Hono canonical pattern — bodyLimit / explicit throws.
		// `getResponse()` returns the pre-built Response (status + body) so
		// status code и payload propagate verbatim. Log at info, not warn —
		// 4xx-class HTTPExceptions are client errors, не bugs.
		c.var.logger?.info({ status: err.status, message: err.message }, 'http exception')
		return err.getResponse()
	}
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
