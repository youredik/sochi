/**
 * Yandex Vision passport OCR routes — operator-triggered scan endpoint.
 *
 * POST /api/v1/passport/scan
 *
 * Per `project_m8_a_6_ui_canonical.md`:
 *   - Operator scans passport image (camera/upload) → recognize → returns
 *     extracted entities + per-field confidence + outcome enum
 *   - 152-ФЗ consent gate: caller MUST send `consent152fzAccepted: true`
 *     (per 2025-09-01 separate-document требование, штраф до 700к ₽)
 *   - Frontend persists consent + entities в guestDocument через
 *     existing POST /guests/:id/documents flow (M9 integration)
 *
 * RBAC: requires `guest:update` permission (operator scanning гостя).
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../../factory.ts'
import { authMiddleware } from '../../../middleware/auth.ts'
import { requirePermission } from '../../../middleware/require-permission.ts'
import { tenantMiddleware } from '../../../middleware/tenant.ts'
import type { VisionOcrAdapter } from './types.ts'

const scanPassportSchema = z.object({
	imageBase64: z.string().min(1, 'imageBase64 не может быть пустым'),
	mimeType: z.enum(['image/jpeg', 'image/png', 'image/heic', 'application/pdf']),
	countryHint: z.string().min(2).max(3).nullable().optional(),
	consent152fzAccepted: z.literal(true, {
		message:
			'Согласие на обработку персональных данных по 152-ФЗ обязательно (separate document, 2025-09-01)',
	}),
})

export function createVisionRoutesInner(visionAdapter: VisionOcrAdapter) {
	return new Hono<AppEnv>().post(
		'/passport/scan',
		requirePermission({ guest: ['update'] }),
		zValidator('json', scanPassportSchema),
		async (c) => {
			const body = c.req.valid('json')
			const archive = Uint8Array.from(Buffer.from(body.imageBase64, 'base64'))
			if (archive.length === 0) {
				return c.json(
					{
						error: {
							code: 'BAD_REQUEST',
							message: 'imageBase64 декодируется в пустой массив',
						},
					},
					400,
				)
			}
			const result = await visionAdapter.recognizePassport({
				bytes: archive,
				mimeType: body.mimeType,
				countryHint: body.countryHint ?? null,
			})
			return c.json({ data: result }, 200)
		},
	)
}

export function createVisionRoutes(visionAdapter: VisionOcrAdapter) {
	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.route('/', createVisionRoutesInner(visionAdapter))
}
