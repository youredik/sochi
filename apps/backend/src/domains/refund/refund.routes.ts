/**
 * Refund routes — full M6.6 API surface.
 *
 *   POST  /api/v1/payments/:paymentId/refunds
 *   GET   /api/v1/refunds/:id
 *   GET   /api/v1/payments/:paymentId/refunds
 *
 * Auth/tenant chain identical to payment.routes.ts. Idempotency middleware
 * applied — but refund's UNIQUE causality index (`ixRefundCausality`)
 * also serves as DB-level dedup against duplicate triggers (e.g. dispute
 * lost replay), so retries land safely whether the HTTP middleware or
 * the DB-level UNIQUE catches them first.
 */
import { zValidator } from '@hono/zod-validator'
import { refundCreateInput, refundIdParam, refundPaymentParam } from '@horeca/shared'
import { Hono } from 'hono'
import { RefundNotFoundError } from '../../errors/domain.ts'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import type { IdempotencyMiddleware } from '../../middleware/idempotency.ts'
import { requirePermission } from '../../middleware/require-permission.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import type { RefundFactory } from './refund.factory.ts'

export function createRefundRoutes(f: RefundFactory, idempotency: IdempotencyMiddleware) {
	const { service } = f

	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.use('*', idempotency)

		.post(
			'/payments/:paymentId/refunds',
			requirePermission({ refund: ['create'] }),
			zValidator('param', refundPaymentParam),
			zValidator('json', refundCreateInput),
			async (c) => {
				const { paymentId } = c.req.valid('param')
				const input = c.req.valid('json')
				const created = await service.create(
					c.var.tenantId,
					{
						paymentId,
						amountMinor: input.amountMinor,
						reason: input.reason,
						causality: input.causality ?? null,
					},
					c.var.user.id,
				)
				return c.json({ data: created }, 201)
			},
		)

		.get(
			'/refunds/:id',
			requirePermission({ refund: ['read'] }),
			zValidator('param', refundIdParam),
			async (c) => {
				const { id } = c.req.valid('param')
				const item = await service.getById(c.var.tenantId, id)
				if (!item) throw new RefundNotFoundError(id)
				return c.json({ data: item }, 200)
			},
		)

		.get(
			'/payments/:paymentId/refunds',
			requirePermission({ refund: ['read'] }),
			zValidator('param', refundPaymentParam),
			async (c) => {
				const { paymentId } = c.req.valid('param')
				const items = await service.listByPayment(c.var.tenantId, paymentId)
				return c.json({ data: items }, 200)
			},
		)
}
