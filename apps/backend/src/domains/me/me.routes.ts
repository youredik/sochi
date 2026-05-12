/**
 * `GET /api/v1/me` — current member context (role + tenantId + tenant mode).
 *
 * Per memory `project_m6_7_frontend_research.md` round-6 RBAC research:
 *   Frontend useCan hook needs role информацию для UI gating (aria-disabled
 *   + tooltip). Этот endpoint — single source of truth для current member's
 *   role в active organization.
 *
 * **A.bis.2 POST-AUDIT enrichment (C36)** — added `mode` field so the admin
 * app-shell `<DemoModeBadge>` (plan §3 D31) can render `[DEMO]` / `[LIVE]`
 * pill in `<SidebarFooter>`. Loader is injected so unit tests can stub
 * без touching SQL; production wires `loadTenantMode(sql, tenantId)` from
 * `middleware/demo-lock.ts`. Default `'production'` matches
 * `DEFAULT_TENANT_MODE` (legacy tenants pre-0042 + tests w/o wired loader).
 *
 * Why not BA `useActiveMember`: BA 1.6 client-side org plugin has variable
 * shape across versions; explicit endpoint = stable contract. Cached on
 * frontend через TanStack Query (staleTime 30s, refetchOnWindowFocus).
 */
import { DEFAULT_TENANT_MODE, type TenantMode } from '@horeca/shared'
import { Hono } from 'hono'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'

export type LoadTenantMode = (tenantId: string) => Promise<TenantMode>

export function createMeRoutes(loadTenantMode: LoadTenantMode = async () => DEFAULT_TENANT_MODE) {
	return new Hono<AppEnv>().use('*', authMiddleware(), tenantMiddleware()).get('/me', async (c) => {
		const mode = await loadTenantMode(c.var.tenantId)
		return c.json(
			{
				data: {
					userId: c.var.user.id,
					tenantId: c.var.tenantId,
					role: c.var.memberRole,
					mode,
				},
			},
			200,
		)
	})
}
