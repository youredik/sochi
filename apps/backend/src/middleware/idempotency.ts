import { createHash } from 'node:crypto'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { IdempotencyKeyConflictError } from '../errors/domain.ts'
import { factory } from '../factory.ts'
import type { IdempotencyRepo } from './idempotency.repo.ts'

/** HTTP methods that can legitimately take an `Idempotency-Key` header. */
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

/**
 * Stripe-style `Idempotency-Key` HTTP middleware per IETF
 * `draft-ietf-httpapi-idempotency-key-header-07` (Oct 2025):
 *
 *   • Header is optional — if missing, proceed normally (the 400 path
 *     when required is per-resource policy; we don't enforce yet).
 *   • Fingerprint = SHA-256 of `method\npath\nbody`. IETF §2.4 allows
 *     any deterministic algorithm; this covers the three dimensions a
 *     replayed call must match (same intent, same target, same payload).
 *   • Stored record exists + fingerprint matches → replay cached
 *     (status, body) verbatim (§2.6).
 *   • Stored record exists + fingerprint mismatch → 422 via
 *     IdempotencyKeyConflictError (§2.7).
 *   • Stored record absent → run handler, capture response, UPSERT.
 *
 * Concurrent-request 409 detection (§2.7) deferred to Phase 3: первый этап
 * tolerates the SELECT-then-UPSERT race window. Row TTL = 24h native
 * YDB column TTL (migration 0004).
 */
export function idempotencyMiddleware(repo: IdempotencyRepo) {
	return factory.createMiddleware(async (c, next) => {
		if (!MUTATING_METHODS.has(c.req.method)) return next()

		const key = c.req.header('Idempotency-Key')
		if (!key) return next()

		// Hono caches `c.req.text()` so zValidator / handler can still
		// read the body later as JSON via the internal cache.
		const bodyText = c.req.method === 'DELETE' ? '' : await c.req.text()
		const fingerprint = createHash('sha256')
			.update(`${c.req.method}\n${c.req.path}\n${bodyText}`)
			.digest('hex')

		const tenantId = c.var.tenantId
		const stored = await repo.find(tenantId, key)
		if (stored) {
			if (stored.requestFingerprintSha256 !== fingerprint) {
				throw new IdempotencyKeyConflictError(key)
			}
			return c.json(stored.responseBody, stored.responseStatus as ContentfulStatusCode)
		}

		await next()

		// Capture the response — `onError`-handled domain errors still land in
		// `c.res`, so the cache holds the exact reply the client received.
		const res = c.res
		const resBody = await res.clone().text()
		await repo.store(tenantId, key, fingerprint, res.status, resBody, new Date())
	})
}

export type IdempotencyMiddleware = ReturnType<typeof idempotencyMiddleware>
