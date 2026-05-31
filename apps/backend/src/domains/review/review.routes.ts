import { zValidator } from '@hono/zod-validator'
import { idSchema } from '@horeca/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { requirePermission } from '../../middleware/require-permission.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import type { ReviewService } from './review.service.ts'

/**
 * AI review-reply routes (2026-05-30). Tenant-scoped, auth-gated.
 *
 *   GET  /api/v1/properties/:propertyId/reviews   — список отзывов объекта
 *   GET  /api/v1/reviews/:id                       — один отзыв
 *   POST /api/v1/reviews/:id/generate-reply        — ИИ-черновик (YandexGPT)
 *   PUT  /api/v1/reviews/:id/reply                 — сохранить правки (draft)
 *   POST /api/v1/reviews/:id/publish               — опубликовать в канал
 *
 * Доменные ошибки (ReviewNotFound / ReviewAiUnavailable / ReviewReplyRequired /
 * ReviewPublishFailed) пробрасываются в глобальный onError → HTTP_STATUS_MAP.
 * generate-reply/publish идемпотентны по природе (перезапись черновика /
 * markPublished), отдельная idempotency-middleware не требуется.
 */
const propertyParam = z.object({ propertyId: idSchema('property') })
const reviewParam = z.object({ id: idSchema('channelReview') })
const replyBody = z.object({ reply: z.string().trim().min(1).max(4000) })

export function createReviewRoutes(service: ReviewService) {
	return (
		new Hono<AppEnv>()
			.use('*', authMiddleware(), tenantMiddleware())
			.get(
				'/properties/:propertyId/reviews',
				requirePermission({ review: ['read'] }),
				zValidator('param', propertyParam),
				async (c) => {
					const { propertyId } = c.req.valid('param')
					const items = await service.list(c.var.tenantId, propertyId)
					return c.json({ data: items }, 200)
				},
			)
			// Idempotent demo-провизионинг (POST = write-семантика, не GET). Сервер
			// сам гейтит на demo-режим; для prod/уже-засеяно → no-op. Зовётся reviews
			// route loader, чтобы демо-визитёр увидел набор отзывов под своей property.
			.post(
				'/properties/:propertyId/reviews/provision-demo',
				requirePermission({ review: ['read'] }),
				zValidator('param', propertyParam),
				async (c) => {
					const { propertyId } = c.req.valid('param')
					const result = await service.provisionDemoReviews(c.var.tenantId, propertyId)
					return c.json({ data: result }, 200)
				},
			)
			.get(
				'/reviews/:id',
				requirePermission({ review: ['read'] }),
				zValidator('param', reviewParam),
				async (c) => {
					const { id } = c.req.valid('param')
					const review = await service.get(c.var.tenantId, id)
					return c.json({ data: review }, 200)
				},
			)
			.post(
				'/reviews/:id/generate-reply',
				requirePermission({ review: ['reply'] }),
				zValidator('param', reviewParam),
				async (c) => {
					const { id } = c.req.valid('param')
					const review = await service.generateReply(c.var.tenantId, id)
					return c.json({ data: review }, 200)
				},
			)
			.put(
				'/reviews/:id/reply',
				requirePermission({ review: ['reply'] }),
				zValidator('param', reviewParam),
				zValidator('json', replyBody),
				async (c) => {
					const { id } = c.req.valid('param')
					const { reply } = c.req.valid('json')
					const review = await service.saveDraft(c.var.tenantId, id, reply)
					return c.json({ data: review }, 200)
				},
			)
			.post(
				'/reviews/:id/publish',
				requirePermission({ review: ['reply'] }),
				zValidator('param', reviewParam),
				zValidator('json', replyBody),
				async (c) => {
					const { id } = c.req.valid('param')
					const { reply } = c.req.valid('json')
					const review = await service.publish(c.var.tenantId, id, reply)
					return c.json({ data: review }, 200)
				},
			)
	)
}
