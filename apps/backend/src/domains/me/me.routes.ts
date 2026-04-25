/**
 * `GET /api/v1/me` — current member context (role + tenantId).
 *
 * Per memory `project_m6_7_frontend_research.md` round-6 RBAC research:
 *   Frontend useCan hook needs role информацию для UI gating (aria-disabled
 *   + tooltip). Этот endpoint — single source of truth для current member's
 *   role в active organization.
 *
 * Why not BA `useActiveMember`: BA 1.6 client-side org plugin has variable
 * shape across versions; explicit endpoint = stable contract. Cached on
 * frontend через TanStack Query (staleTime 30s, refetchOnWindowFocus).
 */
import { Hono } from 'hono'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'

export function createMeRoutes() {
	return new Hono<AppEnv>().use('*', authMiddleware(), tenantMiddleware()).get('/me', (c) =>
		c.json(
			{
				data: {
					userId: c.var.user.id,
					tenantId: c.var.tenantId,
					role: c.var.memberRole,
				},
			},
			200,
		),
	)
}
