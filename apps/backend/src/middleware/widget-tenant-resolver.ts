/**
 * Public widget tenant-resolver middleware.
 *
 * Resolves `:tenantSlug` URL param → `tenantId` via existing `resolveTenantBySlug`,
 * sets `c.var.tenantId` so downstream existing middleware (e.g. `idempotencyMiddleware`,
 * which reads `c.var.tenantId`) works AS-IS without fork (platform-first canon
 * per `feedback_engineering_philosophy.md`).
 *
 * Per `plans/m9_widget_4_canonical.md` §3 integration map:
 *   - 404 NOT_FOUND on unknown slug (timing-safe — same shape regardless of
 *     whether slug exists or property не public).
 *   - Sets `c.var.tenantId` (typed via `factory.ts:AppEnv.Variables`).
 *   - Sets `c.var.tenant` (full ResolvedTenant) for handler convenience.
 *
 * Usage (booking-create routes):
 *   ```
 *   .use('/:tenantSlug/booking', widgetTenantResolverMiddleware())
 *   .use('/:tenantSlug/booking', idempotencyMiddleware(idempotencyRepo))
 *   .post('/:tenantSlug/booking', zValidator('json', schema), handler)
 *   ```
 *
 * NOT used on read-only widget routes (those handle 404 inline в handler);
 * exclusively для mutating endpoints где idempotency middleware needs tenantId.
 */

import { factory } from '../factory.ts'
import { type ResolvedTenant, resolveTenantBySlug } from '../lib/tenant-resolver.ts'

declare module 'hono' {
	interface ContextVariableMap {
		/** Resolved tenant entity from slug (set by widget-tenant-resolver middleware). */
		readonly tenant: ResolvedTenant
	}
}

export function widgetTenantResolverMiddleware() {
	return factory.createMiddleware(async (c, next) => {
		const slug = c.req.param('tenantSlug')
		if (!slug) {
			return c.json({ error: { code: 'NOT_FOUND', message: 'Tenant not found' } }, 404)
		}
		const resolved = await resolveTenantBySlug(slug)
		if (!resolved) {
			return c.json({ error: { code: 'NOT_FOUND', message: 'Tenant not found' } }, 404)
		}
		c.set('tenantId', resolved.tenantId)
		c.set('tenant', resolved)
		return next()
	})
}
