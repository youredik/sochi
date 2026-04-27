/**
 * Property descriptions repo — YDB integration tests.
 *
 * Strict per `feedback_strict_tests.md`:
 *   1. Locale isolation: ru and en for the same property are independent
 *      rows; updating one does not affect the other.
 *   2. Cross-tenant isolation absolute.
 *   3. Cross-property isolation: same tenant, two properties, same locale
 *      coexist independently.
 *   4. UPSERT idempotency: re-calling with same key returns ONE row.
 *   5. Update-path preserves createdAt; updates updatedAt.
 *   6. sectionsJson roundtrips byte-exact across reads.
 *   7. Empty sections object roundtrips correctly.
 *   8. Corrupt sectionsJson on read raises a descriptive error
 *      (defense-in-depth).
 *   9. listAllLocales returns ORDER BY locale.
 *  10. deleteByLocale: idempotent (false on missing).
 */
import type { PropertyDescriptionInput, PropertyDescriptionLocale } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { NULL_TEXT } from '../../db/ydb-helpers.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createPropertyDescriptionsRepo } from './descriptions.repo.ts'

const RUN_ID = Date.now().toString(36)
const TENANT_A = `org_desc_a_${RUN_ID}`
const TENANT_B = `org_desc_b_${RUN_ID}`
const PROPERTY_A1 = `prop_desc_a1_${RUN_ID}`
const PROPERTY_A2 = `prop_desc_a2_${RUN_ID}`
const PROPERTY_B1 = `prop_desc_b1_${RUN_ID}`
const ACTOR = 'test-actor'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

const validRu: PropertyDescriptionInput = {
	title: 'Гранд Отель Сочи',
	tagline: 'Море и горы',
	summaryMd: 'Краткое описание отеля для виджета.',
	longDescriptionMd: '# Welcome\n\nFull markdown body.',
	sections: {
		location: 'Расположение в центре Адлера, 5 минут до моря.',
		services: 'Спа, ресторан, фитнес-центр.',
	},
	seoMetaTitle: 'Гранд Отель Сочи — отдых у моря',
	seoMetaDescription: '4-звёздочный отель в Сочи с видом на море.',
	seoH1: 'Гранд Отель Сочи',
}

const validEn: PropertyDescriptionInput = {
	title: 'Grand Hotel Sochi',
	tagline: 'Sea and mountains',
	summaryMd: 'Short widget summary in English.',
	longDescriptionMd: '# Welcome\n\nEnglish body.',
	sections: {
		location: 'Adler downtown, 5 min to sea.',
		services: 'Spa, restaurant, fitness centre.',
	},
	seoMetaTitle: 'Grand Hotel Sochi — sea and mountains',
	seoMetaDescription: 'Four-star hotel in Sochi with sea view.',
	seoH1: 'Grand Hotel Sochi',
}

describe('property.descriptions.repo', { tags: ['db'], timeout: 30_000 }, () => {
	let repo: ReturnType<typeof createPropertyDescriptionsRepo>

	beforeAll(async () => {
		await setupTestDb()
		repo = createPropertyDescriptionsRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const t of [TENANT_A, TENANT_B]) {
			for (const p of [PROPERTY_A1, PROPERTY_A2, PROPERTY_B1]) {
				await sql`DELETE FROM propertyDescription WHERE tenantId = ${t} AND propertyId = ${p}`
			}
		}
		await teardownTestDb()
	})

	test('[G1] getByLocale: returns null for unknown row', async () => {
		const out = await repo.getByLocale(TENANT_A, PROPERTY_A1, 'ru')
		expect(out).toBeNull()
	})

	test('[U1] upsert insert path: persists exact input + audit timestamps equal', async () => {
		const out = await repo.upsert(TENANT_A, PROPERTY_A1, 'ru', validRu, ACTOR)
		expect(out.title).toBe(validRu.title)
		expect(out.tagline).toBe(validRu.tagline)
		expect(out.summaryMd).toBe(validRu.summaryMd)
		expect(out.longDescriptionMd).toBe(validRu.longDescriptionMd)
		expect(out.sections).toEqual(validRu.sections)
		expect(out.seoMetaTitle).toBe(validRu.seoMetaTitle)
		expect(out.createdAt).toMatch(ISO)
		expect(out.createdAt).toBe(out.updatedAt) // first insert
	})

	test('[U2] sections JSON byte-exact roundtrip on read', async () => {
		const reread = await repo.getByLocale(TENANT_A, PROPERTY_A1, 'ru')
		expect(reread).not.toBeNull()
		expect(reread?.sections).toEqual(validRu.sections)
		// Verify all 8 canonical keys are absent when not provided
		expect(Object.keys(reread?.sections ?? {})).toEqual(['location', 'services'])
	})

	test('[U3] empty sections object roundtrips correctly', async () => {
		const minInput: PropertyDescriptionInput = {
			title: 'Min',
			tagline: null,
			summaryMd: 'Short.',
			longDescriptionMd: null,
			sections: {},
			seoMetaTitle: null,
			seoMetaDescription: null,
			seoH1: null,
		}
		const out = await repo.upsert(TENANT_A, PROPERTY_A2, 'ru', minInput, ACTOR)
		expect(out.sections).toEqual({})
		const reread = await repo.getByLocale(TENANT_A, PROPERTY_A2, 'ru')
		expect(reread?.sections).toEqual({})
		expect(reread?.tagline).toBeNull()
		expect(reread?.longDescriptionMd).toBeNull()
		expect(reread?.seoMetaTitle).toBeNull()
		expect(reread?.seoMetaDescription).toBeNull()
		expect(reread?.seoH1).toBeNull()
	})

	test('[U4] upsert idempotent: re-call same locale produces ONE row', async () => {
		// Pre-state: PROPERTY_A1 + ru already populated.
		await repo.upsert(TENANT_A, PROPERTY_A1, 'ru', validRu, ACTOR)
		const all = await repo.listAllLocales(TENANT_A, PROPERTY_A1)
		expect(all.filter((d) => d.locale === 'ru')).toHaveLength(1)
	})

	test('[U5] update path: preserves createdAt + monotonically updates updatedAt', async () => {
		const before = await repo.getByLocale(TENANT_A, PROPERTY_A1, 'ru')
		const originalCreated = before?.createdAt
		const originalUpdated = before?.updatedAt
		expect(originalCreated).toBeDefined()

		await new Promise((r) => setTimeout(r, 5))
		const out = await repo.upsert(
			TENANT_A,
			PROPERTY_A1,
			'ru',
			{ ...validRu, title: 'Гранд Отель Сочи (обн)' },
			ACTOR,
		)
		expect(out.title).toBe('Гранд Отель Сочи (обн)')
		expect(out.createdAt).toBe(originalCreated)
		expect(new Date(out.updatedAt).getTime()).toBeGreaterThan(
			new Date(originalUpdated as string).getTime(),
		)
	})

	test('[L1] listAllLocales: empty for unknown property', async () => {
		const out = await repo.listAllLocales(TENANT_A, `prop_no_${RUN_ID}`)
		expect(out).toEqual([])
	})

	test('[L2] independent ru + en rows for same property; ordered by locale', async () => {
		await repo.upsert(TENANT_A, PROPERTY_A1, 'en', validEn, ACTOR)
		const all = await repo.listAllLocales(TENANT_A, PROPERTY_A1)
		expect(all.map((d) => d.locale)).toEqual(['en', 'ru'])
	})

	test('[L3] update ru does NOT touch en row', async () => {
		const enBefore = await repo.getByLocale(TENANT_A, PROPERTY_A1, 'en')
		await repo.upsert(TENANT_A, PROPERTY_A1, 'ru', { ...validRu, title: 'NEW RU TITLE' }, ACTOR)
		const enAfter = await repo.getByLocale(TENANT_A, PROPERTY_A1, 'en')
		expect(enAfter?.title).toBe(enBefore?.title)
		expect(enAfter?.updatedAt).toBe(enBefore?.updatedAt) // unchanged
	})

	test('[D1] deleteByLocale: returns true and removes row', async () => {
		// Seed PROPERTY_A2 + en, then delete it
		await repo.upsert(TENANT_A, PROPERTY_A2, 'en', validEn, ACTOR)
		expect(await repo.getByLocale(TENANT_A, PROPERTY_A2, 'en')).not.toBeNull()

		const removed = await repo.deleteByLocale(TENANT_A, PROPERTY_A2, 'en')
		expect(removed).toBe(true)
		expect(await repo.getByLocale(TENANT_A, PROPERTY_A2, 'en')).toBeNull()
	})

	test('[D2] deleteByLocale: returns false on already-missing row (idempotent)', async () => {
		const removed = await repo.deleteByLocale(TENANT_A, PROPERTY_A2, 'en')
		expect(removed).toBe(false)
	})

	test('[D3] deleteByLocale ru does NOT touch en row', async () => {
		// PROPERTY_A1 has both ru + en.
		const removed = await repo.deleteByLocale(TENANT_A, PROPERTY_A1, 'ru')
		expect(removed).toBe(true)
		const en = await repo.getByLocale(TENANT_A, PROPERTY_A1, 'en')
		expect(en).not.toBeNull()
		// Restore for downstream tests
		await repo.upsert(TENANT_A, PROPERTY_A1, 'ru', validRu, ACTOR)
	})

	test('[CT1] cross-tenant: TENANT_A row invisible to TENANT_B', async () => {
		await repo.upsert(TENANT_B, PROPERTY_B1, 'ru', validRu, ACTOR)
		const aRead = await repo.getByLocale(TENANT_A, PROPERTY_B1, 'ru')
		expect(aRead).toBeNull() // can't see B's row even by guessing propertyId
		const bRead = await repo.getByLocale(TENANT_B, PROPERTY_B1, 'ru')
		expect(bRead).not.toBeNull()
	})

	test('[CT2] cross-tenant delete: TENANT_A cannot delete TENANT_B row', async () => {
		const result = await repo.deleteByLocale(TENANT_A, PROPERTY_B1, 'ru')
		expect(result).toBe(false)
		expect(await repo.getByLocale(TENANT_B, PROPERTY_B1, 'ru')).not.toBeNull()
	})

	test('[CP1] cross-property: same tenant, two properties — same locale coexists', async () => {
		await repo.upsert(TENANT_A, PROPERTY_A2, 'ru', validRu, ACTOR)
		const a1 = await repo.getByLocale(TENANT_A, PROPERTY_A1, 'ru')
		const a2 = await repo.getByLocale(TENANT_A, PROPERTY_A2, 'ru')
		expect(a1).not.toBeNull()
		expect(a2).not.toBeNull()
		expect(a1?.propertyId).toBe(PROPERTY_A1)
		expect(a2?.propertyId).toBe(PROPERTY_A2)
	})

	test('[E1] reading a row with corrupt sectionsJson raises a descriptive error', async () => {
		// Inject a corrupt JSON directly via raw SQL to test defense-in-depth.
		const sql = getTestSql()
		const propertyId = `prop_corrupt_${RUN_ID}`
		const now = new Date()
		await sql`
			UPSERT INTO propertyDescription (
				\`tenantId\`, \`propertyId\`, \`locale\`,
				\`title\`, \`tagline\`, \`summaryMd\`, \`longDescriptionMd\`,
				\`sectionsJson\`,
				\`seoMetaTitle\`, \`seoMetaDescription\`, \`seoH1\`,
				\`createdAt\`, \`createdBy\`, \`updatedAt\`, \`updatedBy\`
			) VALUES (
				${TENANT_A}, ${propertyId}, ${'ru'},
				${'Bad'}, ${NULL_TEXT}, ${'Summary'}, ${NULL_TEXT},
				${'this is not json'},
				${NULL_TEXT}, ${NULL_TEXT}, ${NULL_TEXT},
				${now}, ${'test'}, ${now}, ${'test'}
			)
		`

		await expect(repo.getByLocale(TENANT_A, propertyId, 'ru')).rejects.toThrowError(
			/Corrupt sectionsJson/,
		)

		// Cleanup
		await sql`DELETE FROM propertyDescription WHERE tenantId = ${TENANT_A} AND propertyId = ${propertyId}`
	})

	test('[E2] reading a row with sections containing UNKNOWN keys is rejected (.strict)', async () => {
		// Corrupt by JSON-stringifying an object with an extra key.
		const sql = getTestSql()
		const propertyId = `prop_strict_${RUN_ID}`
		const now = new Date()
		await sql`
			UPSERT INTO propertyDescription (
				\`tenantId\`, \`propertyId\`, \`locale\`,
				\`title\`, \`tagline\`, \`summaryMd\`, \`longDescriptionMd\`,
				\`sectionsJson\`,
				\`seoMetaTitle\`, \`seoMetaDescription\`, \`seoH1\`,
				\`createdAt\`, \`createdBy\`, \`updatedAt\`, \`updatedBy\`
			) VALUES (
				${TENANT_A}, ${propertyId}, ${'ru'},
				${'Bad'}, ${NULL_TEXT}, ${'Summary'}, ${NULL_TEXT},
				${'{"location":"OK","bogusSection":"evil"}'},
				${NULL_TEXT}, ${NULL_TEXT}, ${NULL_TEXT},
				${now}, ${'test'}, ${now}, ${'test'}
			)
		`

		await expect(repo.getByLocale(TENANT_A, propertyId, 'ru')).rejects.toThrowError(
			/Corrupt sectionsJson/,
		)

		// Cleanup
		await sql`DELETE FROM propertyDescription WHERE tenantId = ${TENANT_A} AND propertyId = ${propertyId}`
	})

	test('[I1] FULL-coverage adversarial: every locale roundtrips', async () => {
		const allLocales: PropertyDescriptionLocale[] = ['ru', 'en']
		const propertyId = `prop_locales_${RUN_ID}`
		for (const loc of allLocales) {
			await repo.upsert(TENANT_A, propertyId, loc, { ...validRu, title: `Title ${loc}` }, ACTOR)
		}
		const list = await repo.listAllLocales(TENANT_A, propertyId)
		expect(list.map((d) => d.locale)).toEqual(allLocales.toSorted())
		// Cleanup
		const sql = getTestSql()
		await sql`DELETE FROM propertyDescription WHERE tenantId = ${TENANT_A} AND propertyId = ${propertyId}`
	})
})
