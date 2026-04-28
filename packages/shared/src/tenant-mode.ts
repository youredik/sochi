/**
 * Tenant mode — distinguishes demo tenants (acquisition showcase, Mock
 * adapters always) from production tenants (real операторы, Live adapters
 * when available).
 *
 * Per `project_demo_strategy.md` (always-on demo strategy 2026-04-28):
 * single deployment serves both. Per-tenant adapter resolution lands в
 * M8.B вместе с first Live adapter (КриптоПро for ЕПГУ etc).
 *
 * For NOW (M8.A.demo): mode column exists, infrastructure ready, all
 * tenants resolve to Mock adapters regardless of mode (no Live adapters
 * yet). When М8.B ships first Live adapter:
 *   - mode='production' tenants → Live (КриптоПро/Yandex Vision/ЮKassa)
 *   - mode='demo' tenants → Mock (forever, free, fast acquisition demo)
 */

import { z } from 'zod'

export const TENANT_MODE_VALUES = ['production', 'demo'] as const
export const tenantModeSchema = z.enum(TENANT_MODE_VALUES)
export type TenantMode = z.infer<typeof tenantModeSchema>

/** Default for new tenants — production. Demo tenants must opt in via seeder. */
export const DEFAULT_TENANT_MODE: TenantMode = 'production'

/**
 * Pure helper: parse mode from organizationProfile row. Treats null/missing
 * as production (default safe behaviour for legacy tenants pre-0042 migration).
 */
export function parseTenantMode(raw: string | null | undefined): TenantMode {
	if (raw === 'demo') return 'demo'
	return 'production'
}

/**
 * Demo-mode-only operations contract: which actions are blocked для demo
 * tenants protect prospect-session integrity.
 *
 * BLOCKED ops (operate on canonical golden state):
 *   - tenant.delete (would break demo permanently)
 *   - property.delete
 *   - roomType.delete
 *   - room.delete
 *   - booking deletions are partial-blocked: prospect может create bookings,
 *     но cron periodically restores golden state per `project_demo_strategy.md`
 *
 * ALLOWED ops (prospect can interact):
 *   - all reads, all create/update operations on operational entities
 *   - booking create/check-in/cancel (refresh cron cleans up)
 *   - notifications send (Mock adapters → no real emails)
 *
 * This list mirrors `apps/backend/src/middleware/demo-lock.ts` — keep in sync.
 */
export const DEMO_BLOCKED_OPERATIONS: ReadonlySet<string> = new Set([
	'tenant.delete',
	'organization.delete',
	'property.delete',
	'roomType.delete',
	'room.delete',
])

export function isDemoBlockedOperation(operationKey: string): boolean {
	return DEMO_BLOCKED_OPERATIONS.has(operationKey)
}
