/**
 * Property media repo. CRUD for `propertyMedia` rows.
 *
 * Service-layer guarantees (callers MUST validate before calling repo):
 *   1. `propertyMediaCreateInputSchema` for inserts.
 *   2. `propertyMediaPatchSchema` for patches.
 *   3. `checkHeroAltText` invariant for hero images.
 *   4. Hero invariant: when promoting to hero, the SERVICE unsets all
 *      other heroes for the same (property, roomType?) — repo offers a
 *      `setHeroExclusive` helper that does this in one Serializable tx.
 */

import type {
	MediaKind,
	PropertyMedia,
	PropertyMediaCreateInput,
	PropertyMediaPatch,
} from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import { NULL_TEXT, textOpt, toTs } from '../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

type MediaDbRow = {
	tenantId: string
	propertyId: string
	mediaId: string
	roomTypeId: string | null
	kind: string
	originalKey: string
	mimeType: string
	widthPx: number | bigint
	heightPx: number | bigint
	fileSizeBytes: bigint | number
	exifStripped: boolean
	derivedReady: boolean
	sortOrder: number | bigint
	isHero: boolean
	altRu: string
	altEn: string | null
	captionRu: string | null
	captionEn: string | null
	createdAt: Date
	updatedAt: Date
}

function rowToMedia(r: MediaDbRow): PropertyMedia {
	return {
		tenantId: r.tenantId,
		propertyId: r.propertyId,
		mediaId: r.mediaId,
		roomTypeId: r.roomTypeId,
		kind: r.kind as PropertyMedia['kind'],
		originalKey: r.originalKey,
		mimeType: r.mimeType as PropertyMedia['mimeType'],
		widthPx: Number(r.widthPx),
		heightPx: Number(r.heightPx),
		fileSizeBytes: typeof r.fileSizeBytes === 'bigint' ? r.fileSizeBytes : BigInt(r.fileSizeBytes),
		exifStripped: r.exifStripped,
		derivedReady: r.derivedReady,
		sortOrder: Number(r.sortOrder),
		isHero: r.isHero,
		altRu: r.altRu,
		altEn: r.altEn,
		captionRu: r.captionRu,
		captionEn: r.captionEn,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
	}
}

export interface ListMediaFilter {
	readonly roomTypeId?: string | null
	readonly kind?: MediaKind
	readonly onlyDerivedReady?: boolean
}

export function createMediaRepo(sql: SqlInstance) {
	return {
		/**
		 * List media for a property. `roomTypeId=null` filters property-scope
		 * (lobby/exterior); a string filters that room. Omit to include all.
		 *
		 * Result ordered by (sortOrder, createdAt) for deterministic UI.
		 */
		async listByProperty(
			tenantId: string,
			propertyId: string,
			filter: ListMediaFilter = {},
		): Promise<PropertyMedia[]> {
			// Build the query — YDB query has no easy way to do conditional
			// WHERE; we read all and filter in JS. Property media count per
			// property is bounded (<200 photos in practice), so the cost is
			// negligible.
			const [rows = []] = await sql<MediaDbRow[]>`
				SELECT *
				FROM propertyMedia
				WHERE tenantId = ${tenantId} AND propertyId = ${propertyId}
				ORDER BY sortOrder, createdAt
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			let mapped = rows.map(rowToMedia)
			if (filter.roomTypeId !== undefined) {
				mapped = mapped.filter((m) => m.roomTypeId === filter.roomTypeId)
			}
			if (filter.kind !== undefined) {
				mapped = mapped.filter((m) => m.kind === filter.kind)
			}
			if (filter.onlyDerivedReady === true) {
				mapped = mapped.filter((m) => m.derivedReady)
			}
			return mapped
		},

		async getById(
			tenantId: string,
			propertyId: string,
			mediaId: string,
		): Promise<PropertyMedia | null> {
			const [rows = []] = await sql<MediaDbRow[]>`
				SELECT *
				FROM propertyMedia
				WHERE tenantId = ${tenantId}
				  AND propertyId = ${propertyId}
				  AND mediaId = ${mediaId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToMedia(row) : null
		},

		async create(
			tenantId: string,
			propertyId: string,
			mediaId: string,
			input: PropertyMediaCreateInput,
			actorId: string,
		): Promise<PropertyMedia> {
			const now = new Date()
			const nowTs = toTs(now)
			const altEn = input.altEn ?? null
			const captionRu = input.captionRu ?? null
			const captionEn = input.captionEn ?? null
			await sql`
				UPSERT INTO propertyMedia (
					\`tenantId\`, \`propertyId\`, \`mediaId\`,
					\`roomTypeId\`, \`kind\`, \`originalKey\`, \`mimeType\`,
					\`widthPx\`, \`heightPx\`, \`fileSizeBytes\`,
					\`exifStripped\`, \`derivedReady\`,
					\`sortOrder\`, \`isHero\`,
					\`altRu\`, \`altEn\`, \`captionRu\`, \`captionEn\`,
					\`createdAt\`, \`createdBy\`, \`updatedAt\`, \`updatedBy\`
				) VALUES (
					${tenantId}, ${propertyId}, ${mediaId},
					${textOpt(input.roomTypeId)}, ${input.kind}, ${input.originalKey}, ${input.mimeType},
					${input.widthPx}, ${input.heightPx}, ${input.fileSizeBytes},
					${false}, ${false},
					${0}, ${false},
					${input.altRu}, ${textOpt(altEn)}, ${textOpt(captionRu)}, ${textOpt(captionEn)},
					${nowTs}, ${actorId}, ${nowTs}, ${actorId}
				)
			`
			return {
				tenantId,
				propertyId,
				mediaId,
				roomTypeId: input.roomTypeId,
				kind: input.kind,
				originalKey: input.originalKey,
				mimeType: input.mimeType,
				widthPx: input.widthPx,
				heightPx: input.heightPx,
				fileSizeBytes: input.fileSizeBytes,
				exifStripped: false,
				derivedReady: false,
				sortOrder: 0,
				isHero: false,
				altRu: input.altRu,
				altEn,
				captionRu,
				captionEn,
				createdAt: now.toISOString(),
				updatedAt: now.toISOString(),
			}
		},

		async patch(
			tenantId: string,
			propertyId: string,
			mediaId: string,
			input: PropertyMediaPatch,
			actorId: string,
		): Promise<PropertyMedia | null> {
			return sql.begin(async (tx) => {
				const [rows = []] = await tx<MediaDbRow[]>`
					SELECT *
					FROM propertyMedia
					WHERE tenantId = ${tenantId}
					  AND propertyId = ${propertyId}
					  AND mediaId = ${mediaId}
					LIMIT 1
				`
				const row = rows[0]
				if (!row) return null
				const current = rowToMedia(row)
				const merged: PropertyMedia = {
					...current,
					altRu: 'altRu' in input && input.altRu !== undefined ? input.altRu : current.altRu,
					altEn: 'altEn' in input && input.altEn !== undefined ? input.altEn : current.altEn,
					captionRu:
						'captionRu' in input && input.captionRu !== undefined
							? input.captionRu
							: current.captionRu,
					captionEn:
						'captionEn' in input && input.captionEn !== undefined
							? input.captionEn
							: current.captionEn,
					sortOrder:
						'sortOrder' in input && input.sortOrder !== undefined
							? input.sortOrder
							: current.sortOrder,
					updatedAt: new Date().toISOString(),
				}
				const now = new Date(merged.updatedAt)
				await tx`
					UPDATE propertyMedia SET
						altRu = ${merged.altRu},
						altEn = ${textOpt(merged.altEn)},
						captionRu = ${textOpt(merged.captionRu)},
						captionEn = ${textOpt(merged.captionEn)},
						sortOrder = ${merged.sortOrder},
						updatedAt = ${toTs(now)},
						updatedBy = ${actorId}
					WHERE tenantId = ${tenantId}
					  AND propertyId = ${propertyId}
					  AND mediaId = ${mediaId}
				`
				return merged
			})
		},

		/**
		 * Mark Cloud Function processing complete. Sets `derivedReady=true`,
		 * `exifStripped=true`. Idempotent.
		 */
		async markProcessed(
			tenantId: string,
			propertyId: string,
			mediaId: string,
			actorId: string,
		): Promise<boolean> {
			return sql.begin(async (tx) => {
				const [rows = []] = await tx<{ x: number }[]>`
					SELECT 1 AS x
					FROM propertyMedia
					WHERE tenantId = ${tenantId}
					  AND propertyId = ${propertyId}
					  AND mediaId = ${mediaId}
					LIMIT 1
				`
				if (rows.length === 0) return false
				const now = new Date()
				await tx`
					UPDATE propertyMedia SET
						derivedReady = ${true},
						exifStripped = ${true},
						updatedAt = ${toTs(now)},
						updatedBy = ${actorId}
					WHERE tenantId = ${tenantId}
					  AND propertyId = ${propertyId}
					  AND mediaId = ${mediaId}
				`
				return true
			})
		},

		/**
		 * Promote `mediaId` to hero, demote ALL other heroes for the same
		 * (property, roomType?) in one Serializable tx. roomType-NULL hero
		 * is independent of room-scope heroes.
		 *
		 * Returns the promoted row, or null if `mediaId` not found.
		 */
		async setHeroExclusive(
			tenantId: string,
			propertyId: string,
			mediaId: string,
			actorId: string,
		): Promise<PropertyMedia | null> {
			return sql.begin(async (tx) => {
				const [rows = []] = await tx<MediaDbRow[]>`
					SELECT *
					FROM propertyMedia
					WHERE tenantId = ${tenantId}
					  AND propertyId = ${propertyId}
					  AND mediaId = ${mediaId}
					LIMIT 1
				`
				const target = rows[0]
				if (!target) return null
				const now = new Date()
				const nowTs = toTs(now)
				// Demote all other heroes in the same scope.
				if (target.roomTypeId === null) {
					await tx`
						UPDATE propertyMedia SET
							isHero = ${false},
							updatedAt = ${nowTs},
							updatedBy = ${actorId}
						WHERE tenantId = ${tenantId}
						  AND propertyId = ${propertyId}
						  AND roomTypeId IS NULL
						  AND isHero = ${true}
						  AND mediaId != ${mediaId}
					`
				} else {
					await tx`
						UPDATE propertyMedia SET
							isHero = ${false},
							updatedAt = ${nowTs},
							updatedBy = ${actorId}
						WHERE tenantId = ${tenantId}
						  AND propertyId = ${propertyId}
						  AND roomTypeId = ${target.roomTypeId}
						  AND isHero = ${true}
						  AND mediaId != ${mediaId}
					`
				}
				// Promote target.
				await tx`
					UPDATE propertyMedia SET
						isHero = ${true},
						updatedAt = ${nowTs},
						updatedBy = ${actorId}
					WHERE tenantId = ${tenantId}
					  AND propertyId = ${propertyId}
					  AND mediaId = ${mediaId}
				`
				const [reread = []] = await tx<MediaDbRow[]>`
					SELECT *
					FROM propertyMedia
					WHERE tenantId = ${tenantId}
					  AND propertyId = ${propertyId}
					  AND mediaId = ${mediaId}
					LIMIT 1
				`
				const updated = reread[0]
				return updated ? rowToMedia(updated) : null
			})
		},

		async delete(tenantId: string, propertyId: string, mediaId: string): Promise<boolean> {
			const [rows = []] = await sql<{ x: number }[]>`
				SELECT 1 AS x
				FROM propertyMedia
				WHERE tenantId = ${tenantId}
				  AND propertyId = ${propertyId}
				  AND mediaId = ${mediaId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			if (rows.length === 0) return false
			await sql`
				DELETE FROM propertyMedia
				WHERE tenantId = ${tenantId}
				  AND propertyId = ${propertyId}
				  AND mediaId = ${mediaId}
			`
			return true
		},
	}
}

// Re-export typed null helpers used in test fixtures
export { NULL_TEXT }
