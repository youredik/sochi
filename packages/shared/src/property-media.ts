/**
 * Property media — photos, 360° tours, and video clips for property/room.
 *
 * Per plan v2 §7.1 #1 + research/hotel-content-amenities-media.md §§5.1-5.5.
 *
 * Pipeline (per research §5.3 — Yandex Cloud has no managed image transform
 * service like Cloudinary, so we build it):
 *   1. Operator requests pre-signed PUT URL via `MediaStorage.getPresignedPut`.
 *   2. Browser PUTs original directly to Object Storage `media-original/`.
 *   3. Cloud Function trigger (deferred to M9 deploy) reads original, runs
 *      `sharp.withMetadata({ exif: {} })` (EXIF strip), generates 6 variants
 *      × 2 formats (AVIF + WebP) → `media-derived/`. Originals kept for
 *      OTA distribution.
 *   4. Cloud Function flips `propertyMedia.derivedReady = true` and
 *      `exifStripped = true` via callback to backend.
 *   5. Frontend renders `<picture>` with srcset of pre-rendered variants.
 *
 * Hero invariant: exactly ONE hero per (property, roomType?) — enforced at
 * service boundary (repo allows multiple; service unsets others on setHero).
 */

import { z } from 'zod'

// ─── Allowed MIME types ──────────────────────────────────────────────────

/**
 * MIME types accepted at upload time. Originals are JPEG / HEIC (modern
 * phones); on Cloud Function side they're transcoded to JPEG (master) and
 * AVIF + WebP (variants). PNG accepted for screenshots / floor plans.
 */
export const mediaMimeTypeValues = [
	'image/jpeg',
	'image/heic',
	'image/heif',
	'image/png',
	'image/webp',
] as const
export const mediaMimeTypeSchema = z.enum(mediaMimeTypeValues)
export type MediaMimeType = z.infer<typeof mediaMimeTypeSchema>

// ─── Media kind ──────────────────────────────────────────────────────────

export const mediaKindValues = ['photo', 'photo_360', 'video_tour'] as const
export const mediaKindSchema = z.enum(mediaKindValues)
export type MediaKind = z.infer<typeof mediaKindSchema>

// ─── Variant labels (pre-rendered widths) ────────────────────────────────

/**
 * Pre-rendered variant widths × 2 formats (AVIF + WebP). `original` keeps
 * the source format (JPEG transcode for HEIC; PNG/WebP passthrough).
 */
export const mediaVariantValues = [
	'thumb', // 320 — search-result card
	'card', // 800 — property card hero
	'medium', // 1280 — room gallery card
	'large', // 1920 — hero / lightbox
	'xl', // 2880 — retina lightbox
	'original', // source (master for OTA)
] as const
export const mediaVariantSchema = z.enum(mediaVariantValues)
export type MediaVariant = z.infer<typeof mediaVariantSchema>

export const mediaDerivedFormatValues = ['avif', 'webp'] as const
export const mediaDerivedFormatSchema = z.enum(mediaDerivedFormatValues)
export type MediaDerivedFormat = z.infer<typeof mediaDerivedFormatSchema>

// ─── Storage layout ──────────────────────────────────────────────────────

/**
 * Build the canonical object key for an original upload. Hierarchical to
 * support per-tenant lifecycle policies and bulk export.
 *
 * Layout: `media-original/<tenantId>/<propertyId>/<mediaId>.<ext>`
 */
export function buildMediaOriginalKey(opts: {
	readonly tenantId: string
	readonly propertyId: string
	readonly mediaId: string
	readonly ext: string
}): string {
	if (opts.ext.includes('/') || opts.ext.includes('.')) {
		throw new Error(`Invalid extension: ${opts.ext}`)
	}
	if (opts.ext.length === 0 || opts.ext.length > 5) {
		throw new Error(`Invalid extension length: ${opts.ext.length}`)
	}
	return `media-original/${opts.tenantId}/${opts.propertyId}/${opts.mediaId}.${opts.ext}`
}

/**
 * Build the canonical key for a derived variant. Layout:
 * `media-derived/<tenantId>/<propertyId>/<mediaId>/<variant>.<format>`
 *
 * Cloud Function writes 6 variants × 2 formats = 12 files per media. The
 * `original` variant uses the source format (no transcode).
 */
export function buildMediaDerivedKey(opts: {
	readonly tenantId: string
	readonly propertyId: string
	readonly mediaId: string
	readonly variant: MediaVariant
	readonly format: MediaDerivedFormat | 'jpeg' | 'png' | 'webp'
}): string {
	return `media-derived/${opts.tenantId}/${opts.propertyId}/${opts.mediaId}/${opts.variant}.${opts.format}`
}

/**
 * Pre-rendered variant catalog — drives `<picture>` / srcset on the
 * frontend. Each entry maps to a CDN URL the operator/caller assembles.
 */
export const MEDIA_VARIANT_WIDTHS: Readonly<Record<MediaVariant, number | null>> = {
	thumb: 320,
	card: 800,
	medium: 1280,
	large: 1920,
	xl: 2880,
	original: null, // source dimensions
}

// ─── Image dimension constraints ─────────────────────────────────────────

/**
 * Source-dimension thresholds (research §5.1):
 *   - Booking.com minimum: 2048 × 1080
 *   - Recommended master:  4000 × 3000 (modern phones)
 *
 * We accept anything ≥ 1024×768 (Expedia minimum) but warn below 2048×1080.
 */
export const MEDIA_MIN_WIDTH_PX = 1024
export const MEDIA_MIN_HEIGHT_PX = 768
export const MEDIA_RECOMMENDED_WIDTH_PX = 2048
export const MEDIA_RECOMMENDED_HEIGHT_PX = 1080

export interface ImageDimensionCheckInput {
	readonly widthPx: number
	readonly heightPx: number
	/** True when this image is to be flagged as `isHero=true`. */
	readonly isHero: boolean
}

export interface ImageDimensionCheckResult {
	/** Hard validation — null if OK, error string otherwise. */
	readonly error: string | null
	/** Soft warnings (advisory; service may emit but not block). */
	readonly warnings: readonly string[]
}

/**
 * Validate image dimensions. Hero images for hotel rooms have an
 * additional 16:9 ratio recommendation (research §5.1).
 *
 * Pure function — covered by `property-media.test.ts`.
 */
export function checkImageDimensions(input: ImageDimensionCheckInput): ImageDimensionCheckResult {
	const warnings: string[] = []
	if (input.widthPx <= 0 || input.heightPx <= 0) {
		return { error: 'Image dimensions must be positive integers', warnings: [] }
	}
	if (input.widthPx < MEDIA_MIN_WIDTH_PX || input.heightPx < MEDIA_MIN_HEIGHT_PX) {
		return {
			error: `Image too small: ${input.widthPx}×${input.heightPx}, minimum ${MEDIA_MIN_WIDTH_PX}×${MEDIA_MIN_HEIGHT_PX}`,
			warnings: [],
		}
	}
	if (input.widthPx < MEDIA_RECOMMENDED_WIDTH_PX || input.heightPx < MEDIA_RECOMMENDED_HEIGHT_PX) {
		warnings.push(
			`Image below recommended ${MEDIA_RECOMMENDED_WIDTH_PX}×${MEDIA_RECOMMENDED_HEIGHT_PX} — Booking.com may reject`,
		)
	}
	if (input.isHero) {
		// 16:9 ratio with 2% tolerance.
		const ratio = input.widthPx / input.heightPx
		const target = 16 / 9
		const tolerance = 0.02 * target
		if (Math.abs(ratio - target) > tolerance) {
			warnings.push(
				`Hero image ratio ${ratio.toFixed(3)} deviates from 16:9 (${target.toFixed(3)}); crop recommended for property card hero`,
			)
		}
	}
	return { error: null, warnings }
}

// ─── Domain row ──────────────────────────────────────────────────────────

/**
 * Alt-text — required in Russian for WCAG 2.2 AA + per `project_axe_a11y_gate.md`.
 * Empty string allowed for explicitly-decorative images.
 */
const altTextSchema = z.string().max(500)

export const propertyMediaSchema = z.object({
	tenantId: z.string(),
	propertyId: z.string(),
	roomTypeId: z.string().nullable(),
	mediaId: z.string(),
	kind: mediaKindSchema,
	originalKey: z.string().min(1).max(500),
	mimeType: mediaMimeTypeSchema,
	widthPx: z.number().int().positive(),
	heightPx: z.number().int().positive(),
	fileSizeBytes: z.bigint().min(0n),
	exifStripped: z.boolean(),
	derivedReady: z.boolean(),
	sortOrder: z.number().int().min(0),
	isHero: z.boolean(),
	altRu: altTextSchema,
	altEn: altTextSchema.nullable(),
	captionRu: z.string().max(500).nullable(),
	captionEn: z.string().max(500).nullable(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
})
export type PropertyMedia = z.infer<typeof propertyMediaSchema>

/**
 * Input for registering an upload (called AFTER browser PUT to Object Storage,
 * BEFORE Cloud Function processes). `derivedReady` and `exifStripped` start
 * `false`; the Cloud Function flips them via callback.
 */
export const propertyMediaCreateInputSchema = z.object({
	roomTypeId: z.string().nullable(),
	kind: mediaKindSchema,
	originalKey: z.string().min(1).max(500),
	mimeType: mediaMimeTypeSchema,
	widthPx: z.number().int().positive(),
	heightPx: z.number().int().positive(),
	fileSizeBytes: z
		.bigint()
		.min(0n)
		.max(50n * 1024n * 1024n), // 50 MB cap
	altRu: altTextSchema,
	altEn: altTextSchema.nullable().optional(),
	captionRu: z.string().max(500).nullable().optional(),
	captionEn: z.string().max(500).nullable().optional(),
})
export type PropertyMediaCreateInput = z.infer<typeof propertyMediaCreateInputSchema>

/**
 * Patch input — updates metadata without re-uploading. Cannot change
 * `originalKey` / `mimeType` / dimensions / file size (those mirror the
 * physical object).
 */
export const propertyMediaPatchSchema = z
	.object({
		altRu: altTextSchema.optional(),
		altEn: altTextSchema.nullable().optional(),
		captionRu: z.string().max(500).nullable().optional(),
		captionEn: z.string().max(500).nullable().optional(),
		sortOrder: z.number().int().min(0).optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, 'At least one field must be provided')
export type PropertyMediaPatch = z.infer<typeof propertyMediaPatchSchema>

/**
 * Cross-field invariant: hero images MUST have a non-empty `altRu` for
 * accessibility (hero is the most prominent image; screen readers and
 * search snippets use it). Returns null if OK, error otherwise.
 */
export function checkHeroAltText(input: {
	readonly isHero: boolean
	readonly altRu: string
}): string | null {
	if (input.isHero && input.altRu.trim().length === 0) {
		return 'Hero image must have a non-empty altRu (WCAG 2.2 AA)'
	}
	return null
}
