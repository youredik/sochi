/**
 * Property-content routes (M8.A.0.fix.4) — RBAC + validation + happy/error
 * paths for amenities + descriptions + media + addons.
 *
 * Per `feedback_strict_tests.md`:
 *   - RBAC matrix: staff = read-only, manager + owner = full
 *     (compliance is owner-only — covered in compliance.routes.test.ts)
 *   - Zod validation: invalid enum / over-length / unknown sections
 *   - Happy paths: response envelope `{ data: ... }`
 *   - Wire conversions: bigints (priceMicros, fileSizeBytes) → strings
 *   - Hero altRu invariant enforced at service layer (smoke; deep coverage
 *     in media.service.test.ts)
 *   - Addon code uniqueness conflict → 409
 */
import type {
	Addon,
	AddonCreateInput,
	MemberRole,
	PropertyAmenityRow,
	PropertyDescription,
	PropertyMedia,
	PropertyMediaCreateInput,
} from '@horeca/shared'
import { describe, expect, test } from 'vitest'
import { onError } from '../../errors/on-error.ts'
import { createTestRouter, type TestContext } from '../../tests/setup.ts'
import type { createAddonsRepo } from './addons.repo.ts'
import type { createAmenitiesRepo } from './amenities.repo.ts'
import type { createPropertyDescriptionsRepo } from './descriptions.repo.ts'
import type { createMediaRepo } from './media.repo.ts'
import type { MediaStorage } from './media-storage.ts'
import type { PropertyContentFactory } from './property-content.factory.ts'
import { createPropertyContentRoutesInner } from './property-content.routes.ts'

const FAKE_USER = {
	id: 'usr-test',
	email: 'test@sochi.local',
	emailVerified: true,
	name: 'Test',
	createdAt: new Date(),
	updatedAt: new Date(),
} as TestContext['user']

const FAKE_SESSION = {
	id: 'ses-test',
	userId: FAKE_USER.id,
	expiresAt: new Date(Date.now() + 3_600_000),
	token: 'tok',
	createdAt: new Date(),
	updatedAt: new Date(),
	ipAddress: '127.0.0.1',
	userAgent: 'test',
	activeOrganizationId: 'org-test',
} as TestContext['session']

function ctxFor(role: MemberRole): TestContext {
	return {
		user: FAKE_USER,
		session: FAKE_SESSION,
		tenantId: 'org-test',
		memberRole: role,
	}
}

const PROPERTY_ID = 'prop_xyz'

// ─── Fake fixtures ───────────────────────────────────────────────────────

const ROW_AMEN: PropertyAmenityRow = {
	tenantId: 'org-test',
	propertyId: PROPERTY_ID,
	amenityCode: 'AMN_RESTAURANT',
	scope: 'property',
	freePaid: 'paid',
	value: null,
	createdAt: '2026-04-27T10:00:00.000Z',
	updatedAt: '2026-04-27T10:00:00.000Z',
}

const ROW_DESC: PropertyDescription = {
	tenantId: 'org-test',
	propertyId: PROPERTY_ID,
	locale: 'ru',
	title: 'Гранд Отель',
	tagline: null,
	summaryMd: 'Краткое описание.',
	longDescriptionMd: null,
	sections: {},
	seoMetaTitle: null,
	seoMetaDescription: null,
	seoH1: null,
	createdAt: '2026-04-27T10:00:00.000Z',
	updatedAt: '2026-04-27T10:00:00.000Z',
}

const ROW_MEDIA: PropertyMedia = {
	tenantId: 'org-test',
	propertyId: PROPERTY_ID,
	mediaId: 'med_abc',
	roomTypeId: null,
	kind: 'photo',
	originalKey: 'media-original/org-test/prop_xyz/med_abc.jpg',
	mimeType: 'image/jpeg',
	widthPx: 4000,
	heightPx: 3000,
	fileSizeBytes: 5_242_880n,
	exifStripped: false,
	derivedReady: false,
	sortOrder: 0,
	isHero: false,
	altRu: 'Описание',
	altEn: null,
	captionRu: null,
	captionEn: null,
	createdAt: '2026-04-27T10:00:00.000Z',
	updatedAt: '2026-04-27T10:00:00.000Z',
}

const ROW_ADDON: Addon = {
	tenantId: 'org-test',
	propertyId: PROPERTY_ID,
	addonId: 'addn_abc',
	code: 'BREAKFAST',
	category: 'FOOD_AND_BEVERAGES',
	nameRu: 'Завтрак',
	nameEn: null,
	descriptionRu: null,
	descriptionEn: null,
	pricingUnit: 'PER_NIGHT_PER_PERSON',
	priceMicros: 800_000_000n,
	currency: 'RUB',
	vatBps: 0,
	isActive: true,
	isMandatory: false,
	inventoryMode: 'NONE',
	dailyCapacity: null,
	seasonalTags: [],
	sortOrder: 0,
	createdAt: '2026-04-27T10:00:00.000Z',
	updatedAt: '2026-04-27T10:00:00.000Z',
}

// ─── Fake factory builder ────────────────────────────────────────────────

interface FactoryOpts {
	mediaPatchReturns?: PropertyMedia | null
	addonExistsReturns?: boolean
	addonPatchReturns?: Addon | null
	descGetReturns?: PropertyDescription | null
	descDeleteReturns?: boolean
	amenityRemoveReturns?: boolean
}

function buildFactory(opts: FactoryOpts = {}): PropertyContentFactory {
	const amenities: ReturnType<typeof createAmenitiesRepo> = {
		listByProperty: async () => [ROW_AMEN],
		upsert: async () => ROW_AMEN,
		remove: async () => ('amenityRemoveReturns' in opts ? opts.amenityRemoveReturns! : true),
		setMany: async () => [ROW_AMEN],
	}
	const descriptions: ReturnType<typeof createPropertyDescriptionsRepo> = {
		listAllLocales: async () => [ROW_DESC],
		getByLocale: async () => ('descGetReturns' in opts ? (opts.descGetReturns ?? null) : ROW_DESC),
		upsert: async () => ROW_DESC,
		deleteByLocale: async () => ('descDeleteReturns' in opts ? opts.descDeleteReturns! : true),
	}
	const media: ReturnType<typeof createMediaRepo> = {
		listByProperty: async () => [ROW_MEDIA],
		getById: async () => ROW_MEDIA,
		create: async () => ROW_MEDIA,
		patch: async () => ('mediaPatchReturns' in opts ? (opts.mediaPatchReturns ?? null) : ROW_MEDIA),
		markProcessed: async () => true,
		setHeroExclusive: async () => ROW_MEDIA,
		delete: async () => true,
	}
	const addons: ReturnType<typeof createAddonsRepo> = {
		listByProperty: async () => [ROW_ADDON],
		getById: async () => ROW_ADDON,
		existsByCode: async () => opts.addonExistsReturns ?? false,
		create: async () => ROW_ADDON,
		patch: async () => ('addonPatchReturns' in opts ? (opts.addonPatchReturns ?? null) : ROW_ADDON),
		delete: async () => true,
	}
	const mediaStorage = {
		mode: 'mock',
		getPresignedPut: async () => ({
			url: 'http://stub/put',
			headers: {},
			expiresAt: '2026-04-27T11:00:00.000Z',
		}),
		getPublicUrl: () => 'http://stub/public',
		markDerivedReady: async () => true,
		getOriginalBytes: async () => null,
		putDerivedBytes: async () => {},
	} satisfies MediaStorage
	return { amenities, descriptions, media, addons, mediaStorage }
}

function buildApp(role: MemberRole, opts: FactoryOpts = {}) {
	const app = createTestRouter(ctxFor(role)).route(
		'/api/v1',
		createPropertyContentRoutesInner(buildFactory(opts)),
	)
	app.onError(onError)
	return app
}

// ───── RBAC sweep ─────────────────────────────────────────────────────────

describe('property-content — RBAC: staff is read-only', () => {
	test('[R1] staff GET amenities → 200', async () => {
		const res = await buildApp('staff').request(`/api/v1/properties/${PROPERTY_ID}/amenities`)
		expect(res.status).toBe(200)
	})
	test('[R2] staff PUT amenities → 403', async () => {
		const res = await buildApp('staff').request(`/api/v1/properties/${PROPERTY_ID}/amenities`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ items: [] }),
		})
		expect(res.status).toBe(403)
	})
	test('[R3] staff DELETE amenity → 403', async () => {
		const res = await buildApp('staff').request(
			`/api/v1/properties/${PROPERTY_ID}/amenities/AMN_RESTAURANT`,
			{ method: 'DELETE' },
		)
		expect(res.status).toBe(403)
	})
	test('[R4] staff POST addon → 403 (sends valid body so we test RBAC, not validation)', async () => {
		const res = await buildApp('staff').request(`/api/v1/properties/${PROPERTY_ID}/addons`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				code: 'X',
				category: 'OTHER',
				nameRu: 'X',
				pricingUnit: 'PER_STAY',
				priceMicros: '100',
				vatBps: 0,
			}),
		})
		expect(res.status).toBe(403)
	})
	test('[R5] staff POST media → 403', async () => {
		const res = await buildApp('staff').request(`/api/v1/properties/${PROPERTY_ID}/media`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				roomTypeId: null,
				kind: 'photo',
				originalKey: 'media-original/x.jpg',
				mimeType: 'image/jpeg',
				widthPx: 4000,
				heightPx: 3000,
				fileSizeBytes: '1000',
				altRu: 'x',
			}),
		})
		expect(res.status).toBe(403)
	})
	test('[R6] staff PUT description → 403', async () => {
		const res = await buildApp('staff').request(
			`/api/v1/properties/${PROPERTY_ID}/descriptions/ru`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					title: 'X',
					tagline: null,
					summaryMd: 'short',
					longDescriptionMd: null,
					sections: {},
					seoMetaTitle: null,
					seoMetaDescription: null,
					seoH1: null,
				}),
			},
		)
		expect(res.status).toBe(403)
	})
})

describe('property-content — RBAC: manager + owner have full', () => {
	test.each(['manager', 'owner'] as const)('%s PUT amenities → 200', async (role) => {
		const res = await buildApp(role).request(`/api/v1/properties/${PROPERTY_ID}/amenities`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ items: [] }),
		})
		expect(res.status).toBe(200)
	})
})

// ───── amenities ──────────────────────────────────────────────────────────

describe('amenities routes', () => {
	test('[A1] GET → returns array shape', async () => {
		const res = await buildApp('owner').request(`/api/v1/properties/${PROPERTY_ID}/amenities`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { data: PropertyAmenityRow[] }
		expect(body.data[0]?.amenityCode).toBe('AMN_RESTAURANT')
	})

	test('[A2] PUT setMany with valid items → 200', async () => {
		const res = await buildApp('owner').request(`/api/v1/properties/${PROPERTY_ID}/amenities`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				items: [{ amenityCode: 'AMN_AC', freePaid: 'free', value: null }],
			}),
		})
		expect(res.status).toBe(200)
	})

	test('[A3] PUT with unknown amenity code → 400 (Zod refine)', async () => {
		const res = await buildApp('owner').request(`/api/v1/properties/${PROPERTY_ID}/amenities`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				items: [{ amenityCode: 'AMN_FAKE', freePaid: 'free', value: null }],
			}),
		})
		expect(res.status).toBe(400)
	})

	test('[A4] DELETE non-existent → 404', async () => {
		const res = await buildApp('owner', { amenityRemoveReturns: false }).request(
			`/api/v1/properties/${PROPERTY_ID}/amenities/AMN_RESTAURANT`,
			{ method: 'DELETE' },
		)
		expect(res.status).toBe(404)
	})
})

// ───── descriptions ───────────────────────────────────────────────────────

describe('descriptions routes', () => {
	test('[D1] GET all locales → 200', async () => {
		const res = await buildApp('owner').request(`/api/v1/properties/${PROPERTY_ID}/descriptions`)
		expect(res.status).toBe(200)
	})

	test('[D2] GET unknown locale → 400 (Zod enum)', async () => {
		const res = await buildApp('owner').request(`/api/v1/properties/${PROPERTY_ID}/descriptions/de`)
		expect(res.status).toBe(400)
	})

	test('[D3] GET missing description for ru → 404', async () => {
		const res = await buildApp('owner', { descGetReturns: null }).request(
			`/api/v1/properties/${PROPERTY_ID}/descriptions/ru`,
		)
		expect(res.status).toBe(404)
	})

	test('[D4] PUT with strict-mode unknown section → 400', async () => {
		const res = await buildApp('owner').request(
			`/api/v1/properties/${PROPERTY_ID}/descriptions/ru`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					title: 'X',
					tagline: null,
					summaryMd: 'short',
					longDescriptionMd: null,
					sections: { bogus: 'evil' },
					seoMetaTitle: null,
					seoMetaDescription: null,
					seoH1: null,
				}),
			},
		)
		expect(res.status).toBe(400)
	})

	test('[D5] PUT happy path → 200', async () => {
		const res = await buildApp('owner').request(
			`/api/v1/properties/${PROPERTY_ID}/descriptions/ru`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					title: 'X',
					tagline: null,
					summaryMd: 'short',
					longDescriptionMd: null,
					sections: { location: 'X' },
					seoMetaTitle: null,
					seoMetaDescription: null,
					seoH1: null,
				}),
			},
		)
		expect(res.status).toBe(200)
	})

	test('[D6] DELETE unknown locale → 404', async () => {
		const res = await buildApp('owner', { descDeleteReturns: false }).request(
			`/api/v1/properties/${PROPERTY_ID}/descriptions/ru`,
			{ method: 'DELETE' },
		)
		expect(res.status).toBe(404)
	})
})

// ───── media ──────────────────────────────────────────────────────────────

const VALID_MEDIA_INPUT: PropertyMediaCreateInput = {
	roomTypeId: null,
	kind: 'photo',
	originalKey: 'media-original/org-test/prop_xyz/m1.jpg',
	mimeType: 'image/jpeg',
	widthPx: 4000,
	heightPx: 3000,
	fileSizeBytes: 5_242_880n,
	altRu: 'Описание',
}

function jsonBigInt(input: unknown): string {
	return JSON.stringify(input, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
}

describe('media routes', () => {
	test('[M1] GET list — fileSizeBytes serialized as string', async () => {
		const res = await buildApp('owner').request(`/api/v1/properties/${PROPERTY_ID}/media`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { data: Array<{ fileSizeBytes: string }> }
		expect(typeof body.data[0]?.fileSizeBytes).toBe('string')
		expect(body.data[0]?.fileSizeBytes).toBe('5242880')
	})

	test('[M2] POST media — wire string fileSizeBytes coerces to bigint → 201', async () => {
		const res = await buildApp('owner').request(`/api/v1/properties/${PROPERTY_ID}/media`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: jsonBigInt(VALID_MEDIA_INPUT),
		})
		expect(res.status).toBe(201)
	})

	test('[M2b] POST media — fileSizeBytes > 50 MB rejected (refine boundary)', async () => {
		const oversize = { ...VALID_MEDIA_INPUT, fileSizeBytes: 50n * 1024n * 1024n + 1n }
		const res = await buildApp('owner').request(`/api/v1/properties/${PROPERTY_ID}/media`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: jsonBigInt(oversize),
		})
		expect(res.status).toBe(400)
	})

	test('[M3] PATCH unknown media → 404', async () => {
		const res = await buildApp('owner', { mediaPatchReturns: null }).request(
			`/api/v1/properties/${PROPERTY_ID}/media/med_unknown`,
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ altRu: 'X' }),
			},
		)
		expect(res.status).toBe(404)
	})

	test('[M4] PATCH empty body → 400 (refine "at least one field")', async () => {
		const res = await buildApp('owner').request(`/api/v1/properties/${PROPERTY_ID}/media/med_abc`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		})
		expect(res.status).toBe(400)
	})

	test('[M5] DELETE happy path → 200', async () => {
		const res = await buildApp('owner').request(`/api/v1/properties/${PROPERTY_ID}/media/med_abc`, {
			method: 'DELETE',
		})
		expect(res.status).toBe(200)
	})

	test('[M6] POST hero on row with empty altRu → 500 (service throws invariant)', async () => {
		// Default fixture ROW_MEDIA.altRu='Описание' — non-empty, so OK.
		// Adversarial: rebuild factory with empty altRu fixture.
		const factory = buildFactory()
		const orig = factory.media.getById
		factory.media.getById = async () => ({ ...ROW_MEDIA, altRu: '   ' })
		const app = createTestRouter(ctxFor('owner')).route(
			'/api/v1',
			createPropertyContentRoutesInner(factory),
		)
		app.onError(onError)
		const res = await app.request(`/api/v1/properties/${PROPERTY_ID}/media/med_abc/hero`, {
			method: 'POST',
		})
		expect(res.status).toBe(500)
		factory.media.getById = orig // restore
	})
})

// ───── addons ─────────────────────────────────────────────────────────────

const VALID_ADDON_INPUT: AddonCreateInput = {
	code: 'NEW_BREAKFAST',
	category: 'FOOD_AND_BEVERAGES',
	nameRu: 'Завтрак',
	nameEn: null,
	descriptionRu: null,
	descriptionEn: null,
	pricingUnit: 'PER_NIGHT_PER_PERSON',
	priceMicros: 800_000_000n,
	currency: 'RUB',
	vatBps: 0,
	isActive: true,
	isMandatory: false,
	inventoryMode: 'NONE',
	dailyCapacity: null,
	seasonalTags: [],
	sortOrder: 0,
}

describe('addons routes', () => {
	test('[X1] GET — priceMicros serialized as string', async () => {
		const res = await buildApp('owner').request(`/api/v1/properties/${PROPERTY_ID}/addons`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { data: Array<{ priceMicros: string }> }
		expect(typeof body.data[0]?.priceMicros).toBe('string')
		expect(body.data[0]?.priceMicros).toBe('800000000')
	})

	test('[X2] POST duplicate code → 409 (existsByCode pre-check)', async () => {
		const res = await buildApp('owner', { addonExistsReturns: true }).request(
			`/api/v1/properties/${PROPERTY_ID}/addons`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: jsonBigInt(VALID_ADDON_INPUT),
			},
		)
		expect(res.status).toBe(409)
	})

	test('[X2b] POST happy path — wire string priceMicros coerces → 201', async () => {
		const res = await buildApp('owner').request(`/api/v1/properties/${PROPERTY_ID}/addons`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: jsonBigInt(VALID_ADDON_INPUT),
		})
		expect(res.status).toBe(201)
		const body = (await res.json()) as { data: { priceMicros: string } }
		expect(typeof body.data.priceMicros).toBe('string')
	})

	test('[X3] POST with TIME_SLOT inventory → 400 (Zod refine — deferred)', async () => {
		const res = await buildApp('owner').request(`/api/v1/properties/${PROPERTY_ID}/addons`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: jsonBigInt({ ...VALID_ADDON_INPUT, inventoryMode: 'TIME_SLOT' }),
		})
		expect(res.status).toBe(400)
	})

	test('[X4] PATCH unknown addon → 404', async () => {
		const res = await buildApp('owner', { addonPatchReturns: null }).request(
			`/api/v1/properties/${PROPERTY_ID}/addons/addn_unknown`,
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ nameRu: 'Updated' }),
			},
		)
		expect(res.status).toBe(404)
	})

	test('[X5] DELETE happy path → 200', async () => {
		const res = await buildApp('owner').request(
			`/api/v1/properties/${PROPERTY_ID}/addons/addn_abc`,
			{ method: 'DELETE' },
		)
		expect(res.status).toBe(200)
	})
})
