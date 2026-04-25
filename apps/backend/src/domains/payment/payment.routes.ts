/**
 * Payment routes — full M6.6 API surface.
 *
 *   POST  /api/v1/properties/:propertyId/bookings/:bookingId/payments
 *   GET   /api/v1/payments/:id
 *   GET   /api/v1/folios/:folioId/payments
 *   GET   /api/v1/properties/:propertyId/bookings/:bookingId/payments
 *
 * Auth/tenant chain identical to booking.routes.ts. Idempotency middleware
 * applied to mutating verbs — but `paymentCreateInput.idempotencyKey` is
 * also enforced at the repo level via UNIQUE index, so retries land on the
 * canonical replay path even without the HTTP middleware (defence-in-depth).
 */
import { zValidator } from '@hono/zod-validator'
import { idSchema, paymentCreateInput, paymentIdParam } from '@horeca/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { PaymentNotFoundError } from '../../errors/domain.ts'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import type { IdempotencyMiddleware } from '../../middleware/idempotency.ts'
import { requirePermission } from '../../middleware/require-permission.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import type { PaymentFactory } from './payment.factory.ts'

const paymentBookingParam = z.object({
	propertyId: idSchema('property'),
	bookingId: idSchema('booking'),
})
const paymentFolioParam = z.object({
	folioId: idSchema('folio'),
})

export function createPaymentRoutes(f: PaymentFactory, idempotency: IdempotencyMiddleware) {
	const { service } = f

	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.use('*', idempotency)

		.post(
			'/properties/:propertyId/bookings/:bookingId/payments',
			requirePermission({ payment: ['create'] }),
			zValidator('param', paymentBookingParam),
			zValidator('json', paymentCreateInput),
			async (c) => {
				const { propertyId, bookingId } = c.req.valid('param')
				const input = c.req.valid('json')
				const result = await service.createIntent(
					c.var.tenantId,
					{
						propertyId,
						bookingId,
						folioId: input.folioId ?? null,
						providerCode: input.providerCode,
						method: input.method,
						amountMinor: input.amountMinor,
						currency: input.currency,
						idempotencyKey: input.idempotencyKey,
						saleChannel: input.saleChannel,
						payerInn: input.payerInn ?? null,
					},
					c.var.user.id,
				)
				// 'replayed' returns 200 (Stripe convention — same body, prior
				// state) while 'created' returns 201 (fresh resource).
				const status = result.kind === 'created' ? 201 : 200
				return c.json({ data: result.payment, kind: result.kind }, status)
			},
		)

		.get(
			'/payments/:id',
			requirePermission({ payment: ['read'] }),
			zValidator('param', paymentIdParam),
			async (c) => {
				const { id } = c.req.valid('param')
				const item = await service.getById(c.var.tenantId, id)
				if (!item) throw new PaymentNotFoundError(id)
				return c.json({ data: item }, 200)
			},
		)

		.get(
			'/folios/:folioId/payments',
			requirePermission({ payment: ['read'] }),
			zValidator('param', paymentFolioParam),
			async (c) => {
				const { folioId } = c.req.valid('param')
				const items = await service.listByFolio(c.var.tenantId, folioId)
				return c.json({ data: items }, 200)
			},
		)

		.get(
			'/properties/:propertyId/bookings/:bookingId/payments',
			requirePermission({ payment: ['read'] }),
			zValidator('param', paymentBookingParam),
			async (c) => {
				const { propertyId, bookingId } = c.req.valid('param')
				const items = await service.listByBooking(c.var.tenantId, propertyId, bookingId)
				return c.json({ data: items }, 200)
			},
		)
}
