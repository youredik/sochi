import { zValidator } from '@hono/zod-validator'
import { citySchema } from '@horeca/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import type { IdempotencyMiddleware } from '../../middleware/idempotency.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import type { OnboardingFactory } from './onboarding.factory.ts'

/**
 * Bulk-inventory onboarding route. Mounted at `/api/v1`:
 *
 *   POST /api/v1/onboarding/inventory
 *     Body: { property: {…}, rooms: 1..200, avgPriceRub: 0..1_000_000 }
 *     Headers: optional `Idempotency-Key` (Stripe-style replay protection)
 *
 * Response: `201 { data: { propertyId, roomTypeId, ratePlanId, roomIds[], avgPriceRub } }`
 *
 * Auth: requires session + active organization. Wizard always runs after
 * signup + org-create — the user is authenticated and tenant is resolved
 * by the time the route fires.
 */
const inventoryInputSchema = z.object({
	property: z.object({
		name: z.string().min(1).max(200),
		address: z.string().min(1).max(500),
		city: citySchema,
		timezone: z.string().min(1).max(64).optional(),
		// Сочи / Адлер / Сириус / Красная Поляна — 200 bp (2%) per
		// Краснодарский край 2026 decision (НК РФ ст.418.5). Optional на API
		// уровне; null treated identically.
		tourismTaxRateBps: z.coerce.number().int().min(0).max(500).nullable().optional(),
	}),
	// Cap at 200 — pragmatic ceiling: 4-digit room numbers start at 200 rooms
	// (room 100 → '200'), beyond that the canonical 100+i numbering needs
	// refinement and the user is almost certainly typing in a wrong number.
	rooms: z.number().int().min(1).max(200),
	// Capped at 1_000_000 ₽ / night — covers ultra-luxury Krasnaya Polyana
	// chalet pricing with margin; anything higher is a typo.
	avgPriceRub: z.number().int().min(0).max(1_000_000),
})

/** Inner — handlers only, used by route tests behind `stubAuthMiddleware`. */
export function createOnboardingRoutesInner(f: OnboardingFactory) {
	const { service } = f
	return new Hono<AppEnv>().post(
		'/onboarding/inventory',
		zValidator('json', inventoryInputSchema),
		async (c) => {
			const input = c.req.valid('json')
			const result = await service.createInventory(c.var.tenantId, {
				property: {
					name: input.property.name,
					address: input.property.address,
					city: input.property.city,
					...(input.property.timezone !== undefined ? { timezone: input.property.timezone } : {}),
					...(input.property.tourismTaxRateBps !== undefined
						? { tourismTaxRateBps: input.property.tourismTaxRateBps }
						: {}),
				},
				rooms: input.rooms,
				avgPriceRub: input.avgPriceRub,
			})
			return c.json(
				{
					data: {
						propertyId: result.propertyId,
						roomTypeId: result.roomTypeId,
						ratePlanId: result.ratePlanId,
						roomIds: result.roomIds,
						avgPriceRub: input.avgPriceRub,
					},
				},
				201,
			)
		},
	)
}

/** Outer — production wiring: auth + tenant + idempotency. Mounted in app.ts. */
export function createOnboardingRoutes(f: OnboardingFactory, idempotency: IdempotencyMiddleware) {
	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware(), idempotency)
		.route('/', createOnboardingRoutesInner(f))
}
