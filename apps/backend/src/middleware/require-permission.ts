/**
 * `requirePermission(...)` — RBAC gate per route handler.
 *
 * Per memory `project_m6_7_frontend_research.md` round-6 research (Apaleo +
 * Cloudbeds + Mews + 54-ФЗ industry consensus):
 *   - **portable check** (NOT BA `auth.api.hasPermission` HTTP roundtrip) — single
 *     source of truth = `@horeca/shared/rbac`. Same matrix client + server.
 *   - chain after `tenantMiddleware` (depends on `c.var.memberRole`).
 *   - Returns 403 FORBIDDEN with code + required permissions для surfacing в UI.
 *
 * **Why no BA hasPermission**: extra DB roundtrip + #7822 false-negative bug в
 * 1.4.x (verify in 1.6, but defence-in-depth via portable matrix is sufficient
 * canon 2026). Frontend uses same `hasPermission` для UI gating — keeps invariant.
 *
 * Usage:
 *   .post('/refunds', authMiddleware(), tenantMiddleware(), idempotency,
 *     requirePermission({ refund: ['create'] }), handler)
 */
import { hasPermission } from '@horeca/shared'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../factory.ts'

export function requirePermission(
	permissions: Record<string, readonly string[]>,
): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const role = c.var.memberRole
		if (!hasPermission(role, permissions)) {
			return c.json(
				{
					error: {
						code: 'FORBIDDEN',
						message: 'Insufficient permissions',
						required: permissions,
						role,
					},
				},
				403,
			)
		}
		await next()
	}
}
