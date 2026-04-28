/**
 * Demo lock middleware — protects always-on demo tenants from prospect
 * destructive ops + ensures golden state survives between sessions.
 *
 * Per `project_demo_strategy.md` (always-on demo as permanent product surface):
 *   - Demo tenants must be browsable freely (read-mostly UX)
 *   - Mutation operations allowed (so prospects can create bookings, etc.)
 *   - Destructive operations BLOCKED — DELETE property/roomType/room/tenant
 *   - Refresh cron periodically restores golden state
 *
 * This middleware enforces the BLOCKED list per
 * `DEMO_BLOCKED_OPERATIONS` constant in shared/tenant-mode.ts.
 *
 * Architecture:
 *   1. Reads tenantMode from organizationProfile (cached в request scope)
 *   2. If mode='demo' AND HTTP method+path matches blocked op → 403 with
 *      i18n-friendly demo-mode error message
 *   3. Otherwise pass-through
 *
 * NOT for production-tenant op restrictions — RBAC handles that. This is
 * specifically about preserving demo integrity for next prospect session.
 */

import { isDemoBlockedOperation, parseTenantMode, type TenantMode } from '@horeca/shared'
import type { Context, MiddlewareHandler, Next } from 'hono'
import type { sql as SQL } from '../db/index.ts'
import type { AppEnv } from '../factory.ts'

type SqlInstance = typeof SQL

/**
 * Map HTTP method + URL path → canonical operation key for blocked-list lookup.
 * Returns null if path doesn't represent a destructive operation.
 *
 * Patterns (must match `DEMO_BLOCKED_OPERATIONS` in shared/tenant-mode.ts):
 *   - DELETE /api/v1/properties/:id        → 'property.delete'
 *   - DELETE /api/v1/room-types/:id        → 'roomType.delete'
 *   - DELETE /api/v1/rooms/:id             → 'room.delete'
 *   - DELETE /api/auth/organization/:id    → 'organization.delete'
 */
function deriveOperationKey(method: string, pathname: string): string | null {
	if (method !== 'DELETE') return null
	if (/^\/api\/v1\/properties\/[^/]+$/.test(pathname)) return 'property.delete'
	if (/^\/api\/v1\/room-types\/[^/]+$/.test(pathname)) return 'roomType.delete'
	if (/^\/api\/v1\/rooms\/[^/]+$/.test(pathname)) return 'room.delete'
	if (/^\/api\/auth\/organization\/[^/]+$/.test(pathname)) return 'organization.delete'
	return null
}

/**
 * Look up tenant mode from organizationProfile. Returns 'production' if
 * row missing OR mode column null/missing (safe default for legacy tenants
 * pre-0042 migration).
 */
export async function loadTenantMode(sql: SqlInstance, tenantId: string): Promise<TenantMode> {
	const [rows = []] = await sql<Array<{ mode: string | null }>>`
		SELECT \`mode\` FROM organizationProfile
		WHERE \`organizationId\` = ${tenantId}
		LIMIT 1
	`.idempotent(true)
	return parseTenantMode(rows[0]?.mode ?? null)
}

/**
 * Build the demo-lock middleware. Caller passes the SQL instance so unit
 * tests can swap to in-memory.
 *
 * Hono middleware contract: throws via `c.json(... , 403)` to short-circuit
 * the request когда op blocked для demo tenant.
 */
export function demoLockMiddleware(sql: SqlInstance): MiddlewareHandler<AppEnv> {
	return async (c: Context<AppEnv>, next: Next) => {
		const url = new URL(c.req.url)
		const opKey = deriveOperationKey(c.req.method, url.pathname)
		if (!opKey || !isDemoBlockedOperation(opKey)) {
			return next()
		}
		// tenantId должен быть set'нут tenantMiddleware'ом ранее в chain'е.
		const tenantId = c.var.tenantId
		if (!tenantId) {
			// Если tenantId не set — middleware ordering issue. Pass-through
			// (auth middleware либо отказал ранее, либо это not-tenanted endpoint).
			return next()
		}
		const mode = await loadTenantMode(sql, tenantId)
		if (mode !== 'demo') {
			return next()
		}
		return c.json(
			{
				error: {
					code: 'DEMO_OPERATION_BLOCKED',
					message:
						`Operation '${opKey}' is not allowed in demo mode. ` +
						`Demo tenants preserve golden state for prospect sessions. ` +
						`Sign up for production account для full access.`,
				},
			},
			403,
		)
	}
}
