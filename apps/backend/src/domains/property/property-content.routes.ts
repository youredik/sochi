/**
 * Property-content routes (M8.A.0.fix.4) — covers four sub-domains:
 *   * **amenities**     — `propertyAmenity` M:N catalog assignments
 *   * **descriptions**  — `propertyDescription` per-locale content
 *   * **media**         — `propertyMedia` upload/process/hero with sharp
 *                         pipeline + altRu hero invariant
 *   * **addons**        — `propertyAddon` Apaleo Services items
 *
 * Mounted under `/api/v1/properties/:propertyId/...` so URL hierarchy
 * mirrors the data model. All endpoints require auth + tenant scope; RBAC
 * gated per-resource via `requirePermission`.
 *
 * Stable response envelope: `{ data: ... }` (matches existing domains).
 * Errors flow through the global `onError` mapper.
 */

import { zValidator } from '@hono/zod-validator'
import {
	type Addon,
	addonCreateInputSchema,
	addonPatchSchema,
	buildMediaOriginalKey,
	type MediaKind,
	type MediaMimeType,
	mediaKindSchema,
	mediaMimeTypeSchema,
	newId,
	type PropertyMedia,
	propertyAmenityInputSchema,
	propertyDescriptionInputSchema,
	propertyDescriptionLocaleSchema,
	propertyMediaCreateInputSchema,
	propertyMediaPatchSchema,
} from '@horeca/shared'
import { Hono } from 'hono'
import sharp from 'sharp'
import { z } from 'zod'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import type { IdempotencyMiddleware } from '../../middleware/idempotency.ts'
import { requirePermission } from '../../middleware/require-permission.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import { finalizeUploaded, setHeroExclusiveSafe, uploadAndProcess } from './media.service.ts'
import type { PropertyContentFactory } from './property-content.factory.ts'

/** Wire shapes — bigints serialized as strings (canon: folio.amountMinor). */
type AddonWire = Omit<Addon, 'priceMicros'> & { priceMicros: string }
type MediaWire = Omit<PropertyMedia, 'fileSizeBytes'> & { fileSizeBytes: string }

const addonToWire = (a: Addon): AddonWire => ({
	...a,
	priceMicros: a.priceMicros.toString(),
})
const mediaToWire = (m: PropertyMedia): MediaWire => ({
	...m,
	fileSizeBytes: m.fileSizeBytes.toString(),
})

const propertyIdParamSchema = z.object({ propertyId: z.string().min(1).max(100) })
const localeParamSchema = z.object({
	propertyId: z.string().min(1).max(100),
	locale: propertyDescriptionLocaleSchema,
})
const codeParamSchema = z.object({
	propertyId: z.string().min(1).max(100),
	code: z.string().min(1).max(50),
})
const mediaIdParamSchema = z.object({
	propertyId: z.string().min(1).max(100),
	mediaId: z.string().min(1).max(100),
})
const addonIdParamSchema = z.object({
	propertyId: z.string().min(1).max(100),
	addonId: z.string().min(1).max(100),
})
const setManyAmenitiesSchema = z.object({
	items: z.array(propertyAmenityInputSchema).max(200),
})

/**
 * Inner router — handlers + RBAC, NO auth/tenant. Tests mount via
 * `createTestRouter(ctx)` for fast unit-level coverage. Production wrapper
 * `createPropertyContentRoutes` adds auth + tenant.
 */
export function createPropertyContentRoutesInner(f: PropertyContentFactory) {
	const { amenities, descriptions, media, addons, mediaStorage } = f

	return (
		new Hono<AppEnv>()
			// ─── amenities ────────────────────────────────────────────────────
			.get(
				'/properties/:propertyId/amenities',
				zValidator('param', propertyIdParamSchema),
				requirePermission({ amenity: ['read'] }),
				async (c) => {
					const { propertyId } = c.req.valid('param')
					const data = await amenities.listByProperty(c.var.tenantId, propertyId)
					return c.json({ data }, 200)
				},
			)
			.put(
				'/properties/:propertyId/amenities',
				requirePermission({ amenity: ['create', 'update', 'delete'] }),
				zValidator('param', propertyIdParamSchema),
				zValidator('json', setManyAmenitiesSchema),
				async (c) => {
					const { propertyId } = c.req.valid('param')
					const { items } = c.req.valid('json')
					const data = await amenities.setMany(c.var.tenantId, propertyId, items, c.var.user.id)
					return c.json({ data }, 200)
				},
			)
			.delete(
				'/properties/:propertyId/amenities/:code',
				zValidator('param', codeParamSchema),
				requirePermission({ amenity: ['delete'] }),
				async (c) => {
					const { propertyId, code } = c.req.valid('param')
					const ok = await amenities.remove(c.var.tenantId, propertyId, code)
					if (!ok) {
						return c.json(
							{ error: { code: 'NOT_FOUND', message: `Amenity '${code}' not assigned` } },
							404,
						)
					}
					return c.json({ data: { success: true } }, 200)
				},
			)

			// ─── descriptions ─────────────────────────────────────────────────
			.get(
				'/properties/:propertyId/descriptions',
				zValidator('param', propertyIdParamSchema),
				requirePermission({ description: ['read'] }),
				async (c) => {
					const { propertyId } = c.req.valid('param')
					const data = await descriptions.listAllLocales(c.var.tenantId, propertyId)
					return c.json({ data }, 200)
				},
			)
			.get(
				'/properties/:propertyId/descriptions/:locale',
				zValidator('param', localeParamSchema),
				requirePermission({ description: ['read'] }),
				async (c) => {
					const { propertyId, locale } = c.req.valid('param')
					const data = await descriptions.getByLocale(c.var.tenantId, propertyId, locale)
					if (!data) {
						return c.json(
							{ error: { code: 'NOT_FOUND', message: `No description for locale '${locale}'` } },
							404,
						)
					}
					return c.json({ data }, 200)
				},
			)
			.put(
				'/properties/:propertyId/descriptions/:locale',
				requirePermission({ description: ['create', 'update'] }),
				zValidator('param', localeParamSchema),
				zValidator('json', propertyDescriptionInputSchema),
				async (c) => {
					const { propertyId, locale } = c.req.valid('param')
					const input = c.req.valid('json')
					const data = await descriptions.upsert(
						c.var.tenantId,
						propertyId,
						locale,
						input,
						c.var.user.id,
					)
					return c.json({ data }, 200)
				},
			)
			.delete(
				'/properties/:propertyId/descriptions/:locale',
				zValidator('param', localeParamSchema),
				requirePermission({ description: ['delete'] }),
				async (c) => {
					const { propertyId, locale } = c.req.valid('param')
					const ok = await descriptions.deleteByLocale(c.var.tenantId, propertyId, locale)
					if (!ok) {
						return c.json(
							{ error: { code: 'NOT_FOUND', message: `No description for '${locale}'` } },
							404,
						)
					}
					return c.json({ data: { success: true } }, 200)
				},
			)

			// ─── media ────────────────────────────────────────────────────────
			.get(
				'/properties/:propertyId/media',
				zValidator('param', propertyIdParamSchema),
				requirePermission({ media: ['read'] }),
				async (c) => {
					const { propertyId } = c.req.valid('param')
					const rows = await media.listByProperty(c.var.tenantId, propertyId)
					return c.json({ data: rows.map(mediaToWire) }, 200)
				},
			)
			.post(
				'/properties/:propertyId/media',
				requirePermission({ media: ['create'] }),
				zValidator('param', propertyIdParamSchema),
				zValidator('json', propertyMediaCreateInputSchema),
				async (c) => {
					const { propertyId } = c.req.valid('param')
					const input = c.req.valid('json')
					const mediaId = newId('media')
					const data = await media.create(c.var.tenantId, propertyId, mediaId, input, c.var.user.id)
					return c.json({ data: mediaToWire(data) }, 201)
				},
			)
			.patch(
				'/properties/:propertyId/media/:mediaId',
				requirePermission({ media: ['update'] }),
				zValidator('param', mediaIdParamSchema),
				zValidator('json', propertyMediaPatchSchema),
				async (c) => {
					const { propertyId, mediaId } = c.req.valid('param')
					const input = c.req.valid('json')
					const data = await media.patch(c.var.tenantId, propertyId, mediaId, input, c.var.user.id)
					if (!data) {
						return c.json(
							{ error: { code: 'NOT_FOUND', message: `Media '${mediaId}' not found` } },
							404,
						)
					}
					return c.json({ data: mediaToWire(data) }, 200)
				},
			)
			.delete(
				'/properties/:propertyId/media/:mediaId',
				zValidator('param', mediaIdParamSchema),
				requirePermission({ media: ['delete'] }),
				async (c) => {
					const { propertyId, mediaId } = c.req.valid('param')
					const ok = await media.delete(c.var.tenantId, propertyId, mediaId)
					if (!ok) {
						return c.json(
							{ error: { code: 'NOT_FOUND', message: `Media '${mediaId}' not found` } },
							404,
						)
					}
					return c.json({ data: { success: true } }, 200)
				},
			)
			.post(
				'/properties/:propertyId/media/:mediaId/process',
				zValidator('param', mediaIdParamSchema),
				requirePermission({ media: ['update'] }),
				async (c) => {
					const { propertyId, mediaId } = c.req.valid('param')
					// Operator triggers post-upload processing once browser-PUT lands.
					const row = await media.getById(c.var.tenantId, propertyId, mediaId)
					if (!row) {
						return c.json(
							{ error: { code: 'NOT_FOUND', message: `Media '${mediaId}' not found` } },
							404,
						)
					}
					const result = await finalizeUploaded(
						{ repo: media, storage: mediaStorage },
						{
							tenantId: c.var.tenantId,
							propertyId,
							mediaId,
							actorId: c.var.user.id,
							originalKey: row.originalKey,
							mimeType: row.mimeType,
						},
					)
					return c.json(
						{
							data: {
								media: mediaToWire(result.media),
								variantCount: result.variantCount,
								derivedKeys: result.derivedKeys,
							},
						},
						200,
					)
				},
			)
			.post(
				'/properties/:propertyId/media/upload',
				zValidator('param', propertyIdParamSchema),
				requirePermission({ media: ['create'] }),
				async (c) => {
					// Multipart end-to-end upload (dev-friendly: combines presign +
					// browser PUT + create + process in one server-side call).
					// Real prod path is the split flow (POST /media → PUT to Object
					// Storage → POST /media/:id/process). This handler exists so the
					// admin UI can demo the pipeline without a Cloud Function.
					const { propertyId } = c.req.valid('param')
					const body = await c.req.parseBody()
					const file = body.file
					const kindStr = (body.kind ?? 'photo') as string
					const altRu = (body.altRu ?? '') as string
					const altEnRaw = body.altEn as string | undefined
					if (!(file instanceof File) || file.size === 0) {
						return c.json(
							{ error: { code: 'BAD_REQUEST', message: 'Missing or empty `file` field' } },
							400,
						)
					}
					const kindParse = mediaKindSchema.safeParse(kindStr)
					if (!kindParse.success) {
						return c.json(
							{ error: { code: 'BAD_REQUEST', message: `Invalid kind: ${kindStr}` } },
							400,
						)
					}
					const mimeParse = mediaMimeTypeSchema.safeParse(file.type)
					if (!mimeParse.success) {
						return c.json(
							{
								error: {
									code: 'BAD_REQUEST',
									message: `Unsupported MIME type: ${file.type}. Use JPEG/PNG/WebP/HEIC.`,
								},
							},
							400,
						)
					}
					if (BigInt(file.size) > 50n * 1024n * 1024n) {
						return c.json(
							{ error: { code: 'PAYLOAD_TOO_LARGE', message: 'File exceeds 50 MB cap' } },
							413,
						)
					}
					const kind: MediaKind = kindParse.data
					const mimeType: MediaMimeType = mimeParse.data
					const buf = Buffer.from(await file.arrayBuffer())
					// Read source dimensions via sharp (single decode, fail-loud on
					// undecodable bytes — the operator gets a clear 400 instead of a
					// half-created row).
					const meta = await sharp(buf).metadata()
					if (!meta.width || !meta.height) {
						return c.json(
							{ error: { code: 'BAD_REQUEST', message: 'Could not decode image dimensions' } },
							400,
						)
					}
					const ext = mimeType.split('/')[1] ?? 'bin'
					const mediaId = newId('media')
					const originalKey = buildMediaOriginalKey({
						tenantId: c.var.tenantId,
						propertyId,
						mediaId,
						ext,
					})
					const result = await uploadAndProcess(
						{ repo: media, storage: mediaStorage },
						{
							tenantId: c.var.tenantId,
							propertyId,
							mediaId,
							actorId: c.var.user.id,
							meta: {
								roomTypeId: null,
								kind,
								originalKey,
								mimeType,
								widthPx: meta.width,
								heightPx: meta.height,
								fileSizeBytes: BigInt(file.size),
								altRu,
								altEn: altEnRaw && altEnRaw !== '' ? altEnRaw : null,
								captionRu: null,
								captionEn: null,
							},
							originalBytes: buf,
						},
					)
					return c.json(
						{
							data: {
								media: mediaToWire(result.media),
								variantCount: result.variantCount,
								derivedKeys: result.derivedKeys,
							},
						},
						201,
					)
				},
			)
			.post(
				'/properties/:propertyId/media/:mediaId/hero',
				zValidator('param', mediaIdParamSchema),
				requirePermission({ media: ['update'] }),
				async (c) => {
					const { propertyId, mediaId } = c.req.valid('param')
					const data = await setHeroExclusiveSafe(
						{ repo: media, storage: mediaStorage },
						{
							tenantId: c.var.tenantId,
							propertyId,
							mediaId,
							actorId: c.var.user.id,
						},
					)
					return c.json({ data: mediaToWire(data) }, 200)
				},
			)

			// ─── addons ───────────────────────────────────────────────────────
			.get(
				'/properties/:propertyId/addons',
				zValidator('param', propertyIdParamSchema),
				requirePermission({ addon: ['read'] }),
				async (c) => {
					const { propertyId } = c.req.valid('param')
					const rows = await addons.listByProperty(c.var.tenantId, propertyId)
					return c.json({ data: rows.map(addonToWire) }, 200)
				},
			)
			.post(
				'/properties/:propertyId/addons',
				requirePermission({ addon: ['create'] }),
				zValidator('param', propertyIdParamSchema),
				zValidator('json', addonCreateInputSchema),
				async (c) => {
					const { propertyId } = c.req.valid('param')
					const input = c.req.valid('json')
					// Service-layer guard for `code` uniqueness within property.
					const exists = await addons.existsByCode(c.var.tenantId, propertyId, input.code)
					if (exists) {
						return c.json(
							{
								error: {
									code: 'CONFLICT',
									message: `Addon code '${input.code}' already exists in this property`,
								},
							},
							409,
						)
					}
					const addonId = newId('addon')
					const data = await addons.create(
						c.var.tenantId,
						propertyId,
						addonId,
						input,
						c.var.user.id,
					)
					return c.json({ data: addonToWire(data) }, 201)
				},
			)
			.patch(
				'/properties/:propertyId/addons/:addonId',
				requirePermission({ addon: ['update'] }),
				zValidator('param', addonIdParamSchema),
				zValidator('json', addonPatchSchema),
				async (c) => {
					const { propertyId, addonId } = c.req.valid('param')
					const input = c.req.valid('json')
					const data = await addons.patch(c.var.tenantId, propertyId, addonId, input, c.var.user.id)
					if (!data) {
						return c.json(
							{ error: { code: 'NOT_FOUND', message: `Addon '${addonId}' not found` } },
							404,
						)
					}
					return c.json({ data: addonToWire(data) }, 200)
				},
			)
			.delete(
				'/properties/:propertyId/addons/:addonId',
				zValidator('param', addonIdParamSchema),
				requirePermission({ addon: ['delete'] }),
				async (c) => {
					const { propertyId, addonId } = c.req.valid('param')
					const ok = await addons.delete(c.var.tenantId, propertyId, addonId)
					if (!ok) {
						return c.json(
							{ error: { code: 'NOT_FOUND', message: `Addon '${addonId}' not found` } },
							404,
						)
					}
					return c.json({ data: { success: true } }, 200)
				},
			)
	)
}

/**
 * Production wrapper — full auth + tenant + idempotency chain.
 *
 * Idempotency-Key opt-in via header (Stripe-style; IETF draft-07). POST
 * /addons + POST /media + PATCH /media + PUT /amenities/descriptions are
 * mutating endpoints where retry-after-network-glitch must not duplicate.
 * Idempotency middleware no-ops on GET, so the same `.use('*', idempotency)`
 * placement covers all mutations without per-route plumbing.
 */
export function createPropertyContentRoutes(
	f: PropertyContentFactory,
	idempotency: IdempotencyMiddleware,
) {
	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.use('*', idempotency)
		.route('/', createPropertyContentRoutesInner(f))
}
