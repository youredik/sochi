/**
 * `processMediaUpload` — local sharp-based variant pipeline.
 *
 * Per plan v2 §7.1 #1 + research/hotel-content-amenities-media.md §5.3.
 *
 * In production this runs as a Yandex Cloud Function trigger on
 * `s3:ObjectCreated:*` for `media-original/`. In dev / tests it's invoked
 * synchronously by the API (`POST /api/properties/:id/media/:mediaId/process`)
 * after the operator confirms the upload landed.
 *
 * Pipeline:
 *   1. Read original bytes (caller passes them — abstraction layer over
 *      Object Storage / fs / tests fixture).
 *   2. EXIF strip via `withMetadata({ exif: {} })` — privacy mandatory
 *      (research §5.3: GPS / device info must not leak).
 *   3. For each (variant, format) pair generate a derived buffer:
 *        thumb 320 / card 800 / medium 1280 / large 1920 / xl 2880 / original
 *      × AVIF + WebP = 12 derived files
 *      (`original` keeps source format — no transcode).
 *   4. Return descriptor map for the caller to upload to derived storage
 *      and flip `propertyMedia.derivedReady=true`.
 *
 * Pure function on bytes — no IO. Caller (route handler) wires it to
 * `MediaStorage`. This means the test suite can verify the pipeline with
 * a small fixture image WITHOUT mocking sharp itself.
 */

import {
	buildMediaDerivedKey,
	MEDIA_VARIANT_WIDTHS,
	type MediaVariant,
	mediaVariantValues,
} from '@horeca/shared'
import sharp from 'sharp'

/**
 * One derived file in the output map. `key` is the canonical S3 path
 * (e.g. `media-derived/<tenant>/<property>/<media>/card.avif`).
 */
export interface DerivedVariant {
	readonly variant: MediaVariant
	readonly format: 'avif' | 'webp' | 'jpeg' | 'png'
	readonly key: string
	readonly bytes: Buffer
	readonly widthPx: number
	readonly heightPx: number
	readonly fileSizeBytes: number
}

export interface ProcessMediaInput {
	readonly tenantId: string
	readonly propertyId: string
	readonly mediaId: string
	readonly originalBytes: Buffer
	/** Source mime — drives the `original` variant's format. */
	readonly sourceMimeType: string
}

export interface ProcessMediaResult {
	readonly variants: readonly DerivedVariant[]
	/** True after the pipeline ran the EXIF-strip step on every output. */
	readonly exifStripped: true
	/** Source dimensions read from the original. */
	readonly sourceWidthPx: number
	readonly sourceHeightPx: number
}

/**
 * Strip EXIF + ICC + XMP from a sharp pipeline. Per `sharp` 0.34 docs:
 * `keepMetadata()` keeps everything; `withMetadata({})` strips most;
 * `withMetadata({ exif: {} })` keeps colour profile but removes EXIF/GPS.
 *
 * We use `keepIccProfile()` (preserves colour fidelity for AVIF/WebP) +
 * default no-EXIF behaviour.
 */
function stripExif(pipeline: sharp.Sharp): sharp.Sharp {
	return pipeline.keepIccProfile()
}

/**
 * Map source mime to the format used for the `original` variant. HEIC →
 * JPEG (HEIC is not portable to OTAs), JPEG/PNG/WebP passthrough.
 */
function originalFormatFor(mime: string): 'jpeg' | 'png' | 'webp' {
	switch (mime) {
		case 'image/png':
			return 'png'
		case 'image/webp':
			return 'webp'
		// HEIC / HEIF / JPEG → JPEG master for OTA distribution.
		default:
			return 'jpeg'
	}
}

/**
 * Pure (in the sense of "no DB, no S3") pipeline. Runs sharp synchronously
 * (sharp uses libvips in worker threads internally — call sites should
 * `await` and not block the event loop).
 *
 * Throws if the source image cannot be decoded.
 */
export async function processMediaUpload(input: ProcessMediaInput): Promise<ProcessMediaResult> {
	if (input.originalBytes.length === 0) {
		throw new Error('processMediaUpload: originalBytes is empty')
	}

	// First decode pass — read source dimensions for sanity logs + the
	// `original` variant. `sharp(buf).metadata()` is metadata-only, fast.
	const sourceMeta = await sharp(input.originalBytes).metadata()
	const sourceWidthPx = sourceMeta.width
	const sourceHeightPx = sourceMeta.height
	if (sourceWidthPx === undefined || sourceHeightPx === undefined) {
		throw new Error(`processMediaUpload: failed to read source dimensions for ${input.mediaId}`)
	}

	const originalFormat = originalFormatFor(input.sourceMimeType)
	const variants: DerivedVariant[] = []

	for (const variant of mediaVariantValues) {
		const targetWidth = MEDIA_VARIANT_WIDTHS[variant]
		// `original` variant keeps source dimensions + source format,
		// only EXIF-stripped. Other variants fan out to AVIF + WebP.
		const formats: Array<'avif' | 'webp' | 'jpeg' | 'png'> =
			variant === 'original' ? [originalFormat] : ['avif', 'webp']

		for (const format of formats) {
			let pipeline = stripExif(sharp(input.originalBytes))
			if (targetWidth !== null) {
				// Only resize down — `withoutEnlargement: true` so a 1024×768
				// source doesn't blow up to 2880×2160.
				pipeline = pipeline.resize({
					width: targetWidth,
					withoutEnlargement: true,
				})
			}
			let formatted: sharp.Sharp
			switch (format) {
				case 'avif':
					formatted = pipeline.avif({ quality: 60, effort: 4 })
					break
				case 'webp':
					formatted = pipeline.webp({ quality: 80 })
					break
				case 'jpeg':
					formatted = pipeline.jpeg({ quality: 85, progressive: true })
					break
				case 'png':
					formatted = pipeline.png({ compressionLevel: 9 })
					break
			}
			const out = await formatted.toBuffer({ resolveWithObject: true })
			variants.push({
				variant,
				format,
				key: buildMediaDerivedKey({
					tenantId: input.tenantId,
					propertyId: input.propertyId,
					mediaId: input.mediaId,
					variant,
					format,
				}),
				bytes: out.data,
				widthPx: out.info.width,
				heightPx: out.info.height,
				fileSizeBytes: out.info.size,
			})
		}
	}

	return {
		variants,
		exifStripped: true as const,
		sourceWidthPx,
		sourceHeightPx,
	}
}

/**
 * Sanity-check: a processed pipeline produced exactly the right matrix
 * of variants. Used by tests + a startup smoke check.
 */
export function expectedVariantCount(): number {
	// 5 sized variants × 2 formats (AVIF + WebP) + 1 `original` × 1 source
	// format = 11 outputs. Wait — original counts once. mediaVariantValues
	// has 6 entries (incl. original). 5 × 2 + 1 = 11.
	const sized = mediaVariantValues.length - 1 // excludes `original`
	return sized * 2 + 1
}
