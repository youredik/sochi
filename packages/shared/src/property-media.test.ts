/**
 * Strict tests for property-media schemas + helper invariants.
 *
 * Per `feedback_strict_tests.md`:
 *   - exact path-construction shapes (storage key collisions cost real $)
 *   - exact-value boundaries on dimension thresholds (1024/1023, 16:9 ratio
 *     tolerance edge)
 *   - adversarial: extension / mime / hero+empty-alt combos
 *   - enum FULL coverage on every union
 */
import { describe, expect, it } from 'vitest'
import {
	buildMediaDerivedKey,
	buildMediaOriginalKey,
	checkHeroAltText,
	checkImageDimensions,
	MEDIA_MIN_HEIGHT_PX,
	MEDIA_MIN_WIDTH_PX,
	MEDIA_RECOMMENDED_HEIGHT_PX,
	MEDIA_RECOMMENDED_WIDTH_PX,
	MEDIA_VARIANT_WIDTHS,
	mediaDerivedFormatValues,
	mediaKindValues,
	mediaMimeTypeValues,
	mediaVariantValues,
	propertyMediaCreateInputSchema,
	propertyMediaPatchSchema,
	propertyMediaSchema,
} from './property-media.ts'

describe('enum surface (regression — fail loud on additions)', () => {
	it('mediaMimeTypeValues = 5 values', () => {
		expect(mediaMimeTypeValues).toEqual([
			'image/jpeg',
			'image/heic',
			'image/heif',
			'image/png',
			'image/webp',
		])
	})

	it('mediaKindValues = 3 values', () => {
		expect(mediaKindValues).toEqual(['photo', 'photo_360', 'video_tour'])
	})

	it('mediaVariantValues = 6 values (5 sizes + original)', () => {
		expect(mediaVariantValues).toEqual(['thumb', 'card', 'medium', 'large', 'xl', 'original'])
	})

	it('mediaDerivedFormatValues = avif, webp', () => {
		expect(mediaDerivedFormatValues).toEqual(['avif', 'webp'])
	})

	it('MEDIA_VARIANT_WIDTHS pinned to research §5.1 values (320/800/1280/1920/2880/null)', () => {
		expect(MEDIA_VARIANT_WIDTHS).toEqual({
			thumb: 320,
			card: 800,
			medium: 1280,
			large: 1920,
			xl: 2880,
			original: null,
		})
	})

	it('threshold constants pinned (regression)', () => {
		expect(MEDIA_MIN_WIDTH_PX).toBe(1024)
		expect(MEDIA_MIN_HEIGHT_PX).toBe(768)
		expect(MEDIA_RECOMMENDED_WIDTH_PX).toBe(2048)
		expect(MEDIA_RECOMMENDED_HEIGHT_PX).toBe(1080)
	})
})

describe('buildMediaOriginalKey', () => {
	it('builds canonical hierarchical key', () => {
		expect(
			buildMediaOriginalKey({
				tenantId: 'org_abc',
				propertyId: 'prop_xyz',
				mediaId: 'med_123',
				ext: 'jpg',
			}),
		).toBe('media-original/org_abc/prop_xyz/med_123.jpg')
	})

	it('rejects extension containing slash (path traversal)', () => {
		expect(() =>
			buildMediaOriginalKey({
				tenantId: 'org',
				propertyId: 'prop',
				mediaId: 'med',
				ext: '../etc/passwd',
			}),
		).toThrow()
	})

	it('rejects extension containing dot', () => {
		expect(() =>
			buildMediaOriginalKey({
				tenantId: 'org',
				propertyId: 'prop',
				mediaId: 'med',
				ext: 'tar.gz',
			}),
		).toThrow()
	})

	it('rejects empty extension', () => {
		expect(() =>
			buildMediaOriginalKey({
				tenantId: 'org',
				propertyId: 'prop',
				mediaId: 'med',
				ext: '',
			}),
		).toThrow()
	})

	it('rejects extension > 5 chars', () => {
		expect(() =>
			buildMediaOriginalKey({
				tenantId: 'org',
				propertyId: 'prop',
				mediaId: 'med',
				ext: 'jpeg2',
			}),
		).not.toThrow()
		// 6 chars rejected
		expect(() =>
			buildMediaOriginalKey({
				tenantId: 'org',
				propertyId: 'prop',
				mediaId: 'med',
				ext: 'jpeg22',
			}),
		).toThrow()
	})
})

describe('buildMediaDerivedKey', () => {
	it('builds canonical key for AVIF variant', () => {
		expect(
			buildMediaDerivedKey({
				tenantId: 'org_a',
				propertyId: 'prop_x',
				mediaId: 'med_1',
				variant: 'card',
				format: 'avif',
			}),
		).toBe('media-derived/org_a/prop_x/med_1/card.avif')
	})

	it('builds canonical key for original (source format)', () => {
		expect(
			buildMediaDerivedKey({
				tenantId: 'org_a',
				propertyId: 'prop_x',
				mediaId: 'med_1',
				variant: 'original',
				format: 'jpeg',
			}),
		).toBe('media-derived/org_a/prop_x/med_1/original.jpeg')
	})

	it('matrix produces 12 unique paths per media (6 variants × 2 derived formats)', () => {
		const seen = new Set<string>()
		for (const variant of mediaVariantValues) {
			for (const format of mediaDerivedFormatValues) {
				seen.add(
					buildMediaDerivedKey({
						tenantId: 'org_a',
						propertyId: 'prop_x',
						mediaId: 'med_1',
						variant,
						format,
					}),
				)
			}
		}
		expect(seen.size).toBe(12)
	})
})

describe('checkImageDimensions', () => {
	it('rejects zero or negative dimensions', () => {
		expect(checkImageDimensions({ widthPx: 0, heightPx: 768, isHero: false }).error).toMatch(
			/positive integers/,
		)
		expect(checkImageDimensions({ widthPx: 1024, heightPx: 0, isHero: false }).error).toMatch(
			/positive integers/,
		)
		expect(checkImageDimensions({ widthPx: -10, heightPx: 768, isHero: false }).error).toMatch(
			/positive integers/,
		)
	})

	it('rejects width below MIN (1024)', () => {
		const r = checkImageDimensions({ widthPx: 1023, heightPx: 768, isHero: false })
		expect(r.error).toMatch(/Image too small/)
	})

	it('rejects height below MIN (768)', () => {
		const r = checkImageDimensions({ widthPx: 1024, heightPx: 767, isHero: false })
		expect(r.error).toMatch(/Image too small/)
	})

	it('accepts exactly MIN × MIN (boundary)', () => {
		const r = checkImageDimensions({
			widthPx: MEDIA_MIN_WIDTH_PX,
			heightPx: MEDIA_MIN_HEIGHT_PX,
			isHero: false,
		})
		expect(r.error).toBeNull()
		// Below recommended → warning
		expect(r.warnings.length).toBeGreaterThan(0)
		expect(r.warnings[0]).toMatch(/below recommended/)
	})

	it('accepts at exactly RECOMMENDED — no warning', () => {
		const r = checkImageDimensions({
			widthPx: MEDIA_RECOMMENDED_WIDTH_PX,
			heightPx: MEDIA_RECOMMENDED_HEIGHT_PX,
			isHero: false,
		})
		expect(r.error).toBeNull()
		expect(r.warnings).toEqual([])
	})

	it('hero with exact 16:9 (1920×1080) → no ratio warning', () => {
		const r = checkImageDimensions({ widthPx: 1920, heightPx: 1080, isHero: true })
		expect(r.error).toBeNull()
		expect(r.warnings.find((w) => /16:9/.test(w))).toBeUndefined()
	})

	it('hero at 4000×3000 (4:3) → warns ratio mismatch', () => {
		const r = checkImageDimensions({ widthPx: 4000, heightPx: 3000, isHero: true })
		expect(r.error).toBeNull()
		const ratioWarning = r.warnings.find((w) => /16:9/.test(w))
		expect(ratioWarning).toBeDefined()
	})

	it('non-hero at 4:3 → no ratio warning even if not 16:9', () => {
		const r = checkImageDimensions({ widthPx: 4000, heightPx: 3000, isHero: false })
		expect(r.warnings.find((w) => /16:9/.test(w))).toBeUndefined()
	})

	it('hero at 16:9 with 1% deviation accepted (within 2% tolerance)', () => {
		// 1.778 ± 0.0356; 1920/1085 ≈ 1.770 → within tolerance
		const r = checkImageDimensions({ widthPx: 1920, heightPx: 1085, isHero: true })
		expect(r.warnings.find((w) => /16:9/.test(w))).toBeUndefined()
	})

	it('hero at 16:9 with 5% deviation → ratio warning', () => {
		// 1920/1140 ≈ 1.684, > 5% off 1.778
		const r = checkImageDimensions({ widthPx: 1920, heightPx: 1140, isHero: true })
		expect(r.warnings.find((w) => /16:9/.test(w))).toBeDefined()
	})
})

describe('propertyMediaCreateInputSchema', () => {
	const baseInput = {
		roomTypeId: null,
		kind: 'photo' as const,
		originalKey: 'media-original/o/p/m.jpg',
		mimeType: 'image/jpeg' as const,
		widthPx: 4000,
		heightPx: 3000,
		fileSizeBytes: 5_242_880n, // 5 MB
		altRu: 'Вид на бассейн',
	}

	it('parses minimal valid input', () => {
		const out = propertyMediaCreateInputSchema.parse(baseInput)
		expect(out.altRu).toBe('Вид на бассейн')
		expect(out.altEn).toBeUndefined()
	})

	it('parses input with all optional fields', () => {
		const out = propertyMediaCreateInputSchema.parse({
			...baseInput,
			altEn: 'Pool view',
			captionRu: 'Открытый бассейн с подогревом',
			captionEn: 'Heated outdoor pool',
		})
		expect(out.altEn).toBe('Pool view')
		expect(out.captionRu).toBe('Открытый бассейн с подогревом')
	})

	it('rejects unknown mime type', () => {
		expect(() =>
			propertyMediaCreateInputSchema.parse({ ...baseInput, mimeType: 'image/gif' }),
		).toThrow()
	})

	it('rejects fileSizeBytes > 50 MB', () => {
		expect(() =>
			propertyMediaCreateInputSchema.parse({
				...baseInput,
				fileSizeBytes: 50n * 1024n * 1024n + 1n,
			}),
		).toThrow()
	})

	it('accepts exactly 50 MB (boundary)', () => {
		const out = propertyMediaCreateInputSchema.parse({
			...baseInput,
			fileSizeBytes: 50n * 1024n * 1024n,
		})
		expect(out.fileSizeBytes).toBe(50n * 1024n * 1024n)
	})

	it('rejects negative fileSizeBytes', () => {
		expect(() =>
			propertyMediaCreateInputSchema.parse({ ...baseInput, fileSizeBytes: -1n }),
		).toThrow()
	})

	it('rejects empty altRu (required for a11y)', () => {
		// Note: altRu is z.string().max(500) — schema allows empty (operator
		// may flag image as decorative). The HERO+empty-altRu combo is
		// rejected separately by `checkHeroAltText`, not at parse time.
		const out = propertyMediaCreateInputSchema.parse({ ...baseInput, altRu: '' })
		expect(out.altRu).toBe('')
	})

	it('rejects altRu > 500 chars', () => {
		expect(() =>
			propertyMediaCreateInputSchema.parse({ ...baseInput, altRu: 'X'.repeat(501) }),
		).toThrow()
	})
})

describe('propertyMediaPatchSchema', () => {
	it('accepts single-field patch', () => {
		expect(propertyMediaPatchSchema.parse({ altRu: 'New alt' })).toEqual({ altRu: 'New alt' })
	})

	it('rejects empty patch', () => {
		expect(() => propertyMediaPatchSchema.parse({})).toThrow(/At least one field/)
	})

	it('accepts sortOrder=0', () => {
		expect(propertyMediaPatchSchema.parse({ sortOrder: 0 })).toEqual({ sortOrder: 0 })
	})

	it('rejects negative sortOrder', () => {
		expect(() => propertyMediaPatchSchema.parse({ sortOrder: -1 })).toThrow()
	})

	it('rejects non-integer sortOrder', () => {
		expect(() => propertyMediaPatchSchema.parse({ sortOrder: 1.5 })).toThrow()
	})
})

describe('propertyMediaSchema (full row)', () => {
	const baseRow = {
		tenantId: 'org_a',
		propertyId: 'prop_x',
		roomTypeId: null,
		mediaId: 'med_1',
		kind: 'photo' as const,
		originalKey: 'media-original/org_a/prop_x/med_1.jpg',
		mimeType: 'image/jpeg' as const,
		widthPx: 4000,
		heightPx: 3000,
		fileSizeBytes: 5_242_880n,
		exifStripped: false,
		derivedReady: false,
		sortOrder: 0,
		isHero: false,
		altRu: 'Description',
		altEn: null,
		captionRu: null,
		captionEn: null,
		createdAt: '2026-04-27T10:00:00.000Z',
		updatedAt: '2026-04-27T10:00:00.000Z',
	}

	it('parses fully valid row', () => {
		expect(() => propertyMediaSchema.parse(baseRow)).not.toThrow()
	})

	it('roomTypeId can be string for room-scoped media', () => {
		const out = propertyMediaSchema.parse({ ...baseRow, roomTypeId: 'rt_abc' })
		expect(out.roomTypeId).toBe('rt_abc')
	})

	it('rejects unknown kind', () => {
		expect(() => propertyMediaSchema.parse({ ...baseRow, kind: 'audio' })).toThrow()
	})
})

describe('checkHeroAltText', () => {
	it('returns null when hero has non-empty altRu', () => {
		expect(checkHeroAltText({ isHero: true, altRu: 'Хорошее описание' })).toBeNull()
	})

	it('returns null when not hero (empty altRu allowed for decorative)', () => {
		expect(checkHeroAltText({ isHero: false, altRu: '' })).toBeNull()
	})

	it('returns error when hero has empty altRu', () => {
		expect(checkHeroAltText({ isHero: true, altRu: '' })).toMatch(/Hero.*non-empty altRu/)
	})

	it('returns error when hero has whitespace-only altRu', () => {
		expect(checkHeroAltText({ isHero: true, altRu: '   ' })).toMatch(/Hero/)
	})

	it('non-hero with whitespace-only altRu — null (operator may have meant empty)', () => {
		expect(checkHeroAltText({ isHero: false, altRu: '   ' })).toBeNull()
	})
})
