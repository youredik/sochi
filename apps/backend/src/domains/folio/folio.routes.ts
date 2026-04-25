/**
 * Folio routes — full M6.6 API surface.
 *   GET    /api/v1/properties/:propertyId/bookings/:bookingId/folios
 *   POST   /api/v1/properties/:propertyId/bookings/:bookingId/folios
 *   GET    /api/v1/properties/:propertyId/folios/receivables   (M6.7.4)
 *   GET    /api/v1/folios/:id
 *   GET    /api/v1/folios/:id/lines
 *   POST   /api/v1/folios/:folioId/lines
 *   PATCH  /api/v1/folios/:folioId/lines/:lineId/void
 *   PATCH  /api/v1/folios/:id/close
 *
 * Auth/tenant chain: authMiddleware + tenantMiddleware (every route).
 * Idempotency: applied to POST + PATCH so client retries are safe.
 *
 * Domain errors (FolioNotFound / InvalidFolioTransition / FolioCurrencyMismatch
 * / FolioVersionConflict / FolioHasDraftLines) bubble through to
 * `app.onError` for canonical JSON envelopes.
 */
import { zValidator } from '@hono/zod-validator'
import {
	folioBookingParam,
	folioCloseInput,
	folioCreateInput,
	folioIdParam,
	folioLineIdParam,
	folioLinePostInput,
	folioLineVoidInput,
	folioPropertyParam,
} from '@horeca/shared'
import { Hono } from 'hono'
import { FolioNotFoundError } from '../../errors/domain.ts'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import type { IdempotencyMiddleware } from '../../middleware/idempotency.ts'
import { requirePermission } from '../../middleware/require-permission.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import type { FolioFactory } from './folio.factory.ts'

export function createFolioRoutes(f: FolioFactory, idempotency: IdempotencyMiddleware) {
	const { service } = f

	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.use('*', idempotency)

		.get(
			'/properties/:propertyId/bookings/:bookingId/folios',
			requirePermission({ folio: ['read'] }),
			zValidator('param', folioBookingParam),
			async (c) => {
				const { bookingId } = c.req.valid('param')
				const items = await service.listByBooking(c.var.tenantId, bookingId)
				return c.json({ data: items }, 200)
			},
		)

		.get(
			'/properties/:propertyId/folios/receivables',
			requirePermission({ folio: ['read'], report: ['read'] }),
			zValidator('param', folioPropertyParam),
			async (c) => {
				const { propertyId } = c.req.valid('param')
				const items = await service.listReceivables(c.var.tenantId, propertyId)
				return c.json({ data: items }, 200)
			},
		)

		.post(
			'/properties/:propertyId/bookings/:bookingId/folios',
			requirePermission({ folio: ['create'] }),
			zValidator('param', folioBookingParam),
			zValidator('json', folioCreateInput),
			async (c) => {
				const { propertyId, bookingId } = c.req.valid('param')
				const input = c.req.valid('json')
				const created = await service.createForBooking(
					c.var.tenantId,
					{
						propertyId,
						bookingId,
						kind: input.kind,
						currency: input.currency,
						companyId: input.companyId ?? null,
					},
					c.var.user.id,
				)
				return c.json({ data: created }, 201)
			},
		)

		.get(
			'/folios/:id',
			requirePermission({ folio: ['read'] }),
			zValidator('param', folioIdParam),
			async (c) => {
				const { id } = c.req.valid('param')
				const item = await service.getById(c.var.tenantId, id)
				if (!item) throw new FolioNotFoundError(id)
				return c.json({ data: item }, 200)
			},
		)

		.get(
			'/folios/:id/lines',
			requirePermission({ folio: ['read'] }),
			zValidator('param', folioIdParam),
			async (c) => {
				const { id } = c.req.valid('param')
				const folio = await service.getById(c.var.tenantId, id)
				if (!folio) throw new FolioNotFoundError(id)
				const lines = await service.listLines(c.var.tenantId, id)
				return c.json({ data: lines }, 200)
			},
		)

		.post(
			'/folios/:id/lines',
			requirePermission({ folio: ['update'] }),
			zValidator('param', folioIdParam),
			zValidator('json', folioLinePostInput),
			async (c) => {
				const { id } = c.req.valid('param')
				const input = c.req.valid('json')
				const folio = await service.getById(c.var.tenantId, id)
				if (!folio) throw new FolioNotFoundError(id)
				const result = await service.postLine(
					c.var.tenantId,
					id,
					{
						category: input.category,
						description: input.description,
						amountMinor: input.amountMinor,
						isAccommodationBase: input.isAccommodationBase,
						taxRateBps: input.taxRateBps,
						routingRuleId: input.routingRuleId ?? null,
						expectedFolioCurrency: folio.currency,
						expectedFolioVersion: folio.version,
					},
					c.var.user.id,
				)
				return c.json({ data: result }, 201)
			},
		)

		.patch(
			'/folios/:folioId/lines/:lineId/void',
			requirePermission({ folio: ['update'] }),
			zValidator('param', folioLineIdParam),
			zValidator('json', folioLineVoidInput),
			async (c) => {
				const { folioId, lineId } = c.req.valid('param')
				const { reason } = c.req.valid('json')
				const result = await service.voidLine(
					c.var.tenantId,
					folioId,
					lineId,
					reason,
					c.var.user.id,
				)
				return c.json({ data: result }, 200)
			},
		)

		.patch(
			'/folios/:id/close',
			requirePermission({ folio: ['close'] }),
			zValidator('param', folioIdParam),
			zValidator('json', folioCloseInput),
			async (c) => {
				const { id } = c.req.valid('param')
				const updated = await service.close(c.var.tenantId, id, c.var.user.id)
				return c.json({ data: updated }, 200)
			},
		)
}
