/**
 * Property descriptions repo. One row per (tenantId, propertyId, locale).
 *
 * Per M8.A.0.3 + research/hotel-content-amenities-media.md §6.
 *
 * `sectionsJson` is stored as Utf8 holding a JSON-stringified object
 * conforming to `propertyDescriptionSectionsSchema`. We deserialize on
 * read; the column type is Utf8 (not Json) because @ydbjs's Json wrapper
 * had inference issues with parameterised binding here, and Utf8+JSON.stringify
 * is universally supported. The .strict schema on read prevents drift if
 * the row was hand-edited.
 *
 * Service-layer guarantee: all input must pass
 * `propertyDescriptionInputSchema` BEFORE calling the repo. Repo trusts
 * but verifies the sections JSON shape on every read (defense-in-depth).
 */

import {
	type PropertyDescription,
	type PropertyDescriptionInput,
	type PropertyDescriptionLocale,
	propertyDescriptionSectionsSchema,
} from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import { textOpt } from '../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

type DescriptionDbRow = {
	tenantId: string
	propertyId: string
	locale: string
	title: string
	tagline: string | null
	summaryMd: string
	longDescriptionMd: string | null
	sectionsJson: string
	seoMetaTitle: string | null
	seoMetaDescription: string | null
	seoH1: string | null
	createdAt: Date
	updatedAt: Date
}

function rowToDescription(r: DescriptionDbRow): PropertyDescription {
	let sections: ReturnType<typeof propertyDescriptionSectionsSchema.parse>
	try {
		sections = propertyDescriptionSectionsSchema.parse(JSON.parse(r.sectionsJson))
	} catch (err) {
		throw new Error(
			`Corrupt sectionsJson for tenantId=${r.tenantId} propertyId=${r.propertyId} locale=${r.locale}: ${(err as Error).message}`,
		)
	}
	return {
		tenantId: r.tenantId,
		propertyId: r.propertyId,
		locale: r.locale as PropertyDescriptionLocale,
		title: r.title,
		tagline: r.tagline,
		summaryMd: r.summaryMd,
		longDescriptionMd: r.longDescriptionMd,
		sections,
		seoMetaTitle: r.seoMetaTitle,
		seoMetaDescription: r.seoMetaDescription,
		seoH1: r.seoH1,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
	}
}

export function createPropertyDescriptionsRepo(sql: SqlInstance) {
	return {
		/** Read description for a specific locale. Returns null if missing. */
		async getByLocale(
			tenantId: string,
			propertyId: string,
			locale: PropertyDescriptionLocale,
		): Promise<PropertyDescription | null> {
			const [rows = []] = await sql<DescriptionDbRow[]>`
				SELECT *
				FROM propertyDescription
				WHERE tenantId = ${tenantId}
				  AND propertyId = ${propertyId}
				  AND locale = ${locale}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToDescription(row) : null
		},

		/** List all locales for a property, sorted by locale. */
		async listAllLocales(tenantId: string, propertyId: string): Promise<PropertyDescription[]> {
			const [rows = []] = await sql<DescriptionDbRow[]>`
				SELECT *
				FROM propertyDescription
				WHERE tenantId = ${tenantId} AND propertyId = ${propertyId}
				ORDER BY locale
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToDescription)
		},

		/**
		 * Idempotent upsert. Preserves `createdAt`/`createdBy` on update path.
		 * Atomic via Serializable tx so a concurrent save can't observe a
		 * partial row.
		 */
		async upsert(
			tenantId: string,
			propertyId: string,
			locale: PropertyDescriptionLocale,
			input: PropertyDescriptionInput,
			actorId: string,
		): Promise<PropertyDescription> {
			return sql.begin(async (tx) => {
				const [existingRows = []] = await tx<DescriptionDbRow[]>`
					SELECT createdAt
					FROM propertyDescription
					WHERE tenantId = ${tenantId}
					  AND propertyId = ${propertyId}
					  AND locale = ${locale}
					LIMIT 1
				`
				const existing = existingRows[0]
				const now = new Date()
				const createdAt = existing ? existing.createdAt : now
				const createdBy = existing ? null : actorId
				const sectionsString = JSON.stringify(input.sections)

				if (existing) {
					await tx`
						UPDATE propertyDescription SET
							title = ${input.title},
							tagline = ${textOpt(input.tagline)},
							summaryMd = ${input.summaryMd},
							longDescriptionMd = ${textOpt(input.longDescriptionMd)},
							sectionsJson = ${sectionsString},
							seoMetaTitle = ${textOpt(input.seoMetaTitle)},
							seoMetaDescription = ${textOpt(input.seoMetaDescription)},
							seoH1 = ${textOpt(input.seoH1)},
							updatedAt = ${now},
							updatedBy = ${actorId}
						WHERE tenantId = ${tenantId}
						  AND propertyId = ${propertyId}
						  AND locale = ${locale}
					`
				} else {
					if (createdBy === null) throw new Error('unreachable: createdBy null on insert path')
					await tx`
						UPSERT INTO propertyDescription (
							\`tenantId\`, \`propertyId\`, \`locale\`,
							\`title\`, \`tagline\`, \`summaryMd\`, \`longDescriptionMd\`,
							\`sectionsJson\`,
							\`seoMetaTitle\`, \`seoMetaDescription\`, \`seoH1\`,
							\`createdAt\`, \`createdBy\`, \`updatedAt\`, \`updatedBy\`
						) VALUES (
							${tenantId}, ${propertyId}, ${locale},
							${input.title}, ${textOpt(input.tagline)}, ${input.summaryMd},
							${textOpt(input.longDescriptionMd)},
							${sectionsString},
							${textOpt(input.seoMetaTitle)}, ${textOpt(input.seoMetaDescription)}, ${textOpt(input.seoH1)},
							${now}, ${createdBy}, ${now}, ${actorId}
						)
					`
				}

				return {
					tenantId,
					propertyId,
					locale,
					title: input.title,
					tagline: input.tagline,
					summaryMd: input.summaryMd,
					longDescriptionMd: input.longDescriptionMd,
					sections: input.sections,
					seoMetaTitle: input.seoMetaTitle,
					seoMetaDescription: input.seoMetaDescription,
					seoH1: input.seoH1,
					createdAt: createdAt.toISOString(),
					updatedAt: now.toISOString(),
				}
			})
		},

		/** Delete a single locale's description. Idempotent. */
		async deleteByLocale(
			tenantId: string,
			propertyId: string,
			locale: PropertyDescriptionLocale,
		): Promise<boolean> {
			const [rowsBefore = []] = await sql<{ x: number }[]>`
				SELECT 1 AS x
				FROM propertyDescription
				WHERE tenantId = ${tenantId}
				  AND propertyId = ${propertyId}
				  AND locale = ${locale}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			if (rowsBefore.length === 0) return false
			await sql`
				DELETE FROM propertyDescription
				WHERE tenantId = ${tenantId}
				  AND propertyId = ${propertyId}
				  AND locale = ${locale}
			`
			return true
		},
	}
}
