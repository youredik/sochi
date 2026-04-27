/**
 * Tenant compliance routes — org-level metadata required for RU regulators.
 *
 * Plan v2 §7.1 #6 — closes M8.A.0.fix.4 service-layer gap.
 *
 * Endpoints (all session-scoped — `tenantId` comes from
 * `tenantMiddleware`, not the URL):
 *   GET   /api/v1/me/compliance   — read current compliance fields
 *   PATCH /api/v1/me/compliance   — three-state patch (KSR id, tax regime,
 *                                   ФЗ-127, revenue, etc.)
 *
 * RBAC:
 *   - `compliance:read`   → owner + manager (manager needs visibility for
 *                          tax-regime guidance UI)
 *   - `compliance:update` → owner only (legal/financial accountability per
 *                          152-ФЗ ст. 6 ч. 3 — DPA holder = owner)
 *
 * Cross-field invariants enforced HERE (service boundary):
 *   - `checkGuestHouseInvariant` — guest_house ⇔ guestHouseFz127Registered
 *   - `checkTaxRegimeInvariant`  — npd ⇔ NPD; ИП ≠ AUSN_DOHODY_RASHODY
 */

import { zValidator } from '@hono/zod-validator'
import {
	checkGuestHouseInvariant,
	checkTaxRegimeInvariant,
	type TenantCompliance,
	tenantCompliancePatchSchema,
} from '@horeca/shared'
import { Hono } from 'hono'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import type { IdempotencyMiddleware } from '../../middleware/idempotency.ts'
import { requirePermission } from '../../middleware/require-permission.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import type { TenantComplianceFactory } from './compliance.factory.ts'

/**
 * Wire shape — bigints serialized as strings (canon convention; matches
 * folio.amountMinor / payment.amountMinor in this codebase). Frontend
 * parses back via `BigInt(...)`.
 */
type ComplianceWire = Omit<TenantCompliance, 'annualRevenueEstimateMicroRub'> & {
	annualRevenueEstimateMicroRub: string | null
}

function toWire(c: TenantCompliance): ComplianceWire {
	return {
		...c,
		annualRevenueEstimateMicroRub:
			c.annualRevenueEstimateMicroRub === null ? null : c.annualRevenueEstimateMicroRub.toString(),
	}
}

// Future M8.B widget will wrap `tenantCompliancePatchSchema` with a Zod
// `.transform()` that accepts `string` for `annualRevenueEstimateMicroRub`
// and converts to bigint. Until then, the patch endpoint accepts only the
// existing schema shape (frontend converts via `BigInt(...)` before send).

/**
 * Inner router — handlers + RBAC, NO auth/tenant. Production wrapper
 * `createTenantComplianceRoutes` adds the chain. Tests mount this directly
 * with `createTestRouter()` for fast unit-style coverage.
 */
export function createTenantComplianceRoutesInner(f: TenantComplianceFactory) {
	const { repo } = f

	return new Hono<AppEnv>()
		.get('/me/compliance', requirePermission({ compliance: ['read'] }), async (c) => {
			const data = await repo.get(c.var.tenantId)
			if (!data) {
				return c.json(
					{ error: { code: 'NOT_FOUND', message: 'Compliance row missing for tenant' } },
					404,
				)
			}
			return c.json({ data: toWire(data) }, 200)
		})
		.patch(
			'/me/compliance',
			requirePermission({ compliance: ['update'] }),
			zValidator('json', tenantCompliancePatchSchema),
			async (c) => {
				const patch = c.req.valid('json')
				const updated = await repo.patch(c.var.tenantId, patch)
				if (!updated) {
					return c.json(
						{ error: { code: 'NOT_FOUND', message: 'Compliance row missing for tenant' } },
						404,
					)
				}
				// Cross-field invariants — advisory but block the response so the
				// operator sees them in real time. We DO NOT roll back the patch;
				// partial state is normal during a multi-step wizard. Service
				// surfaces the violation; UI displays it.
				const guestHouseErr = checkGuestHouseInvariant(updated)
				const regimeErr = checkTaxRegimeInvariant(updated)
				const warnings = [guestHouseErr, regimeErr].filter((w): w is string => w !== null)
				return c.json({ data: toWire(updated), warnings }, 200)
			},
		)
}

/** Production wrapper — full middleware chain (auth + tenant + idempotency). */
export function createTenantComplianceRoutes(
	f: TenantComplianceFactory,
	idempotency: IdempotencyMiddleware,
) {
	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.use('*', idempotency)
		.route('/', createTenantComplianceRoutesInner(f))
}
