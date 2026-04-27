/**
 * Property addons repo. CRUD for `propertyAddon` rows.
 *
 * Service-layer guarantees (callers MUST validate before calling repo):
 *   1. `addonCreateInputSchema` for inserts (refines DAILY_COUNTER capacity,
 *      TIME_SLOT rejected, PERCENT_OF_ROOM_RATE ≤ 100%).
 *   2. `addonPatchSchema` for patches (three-state — undefined keep / null
 *      clear / value set).
 *   3. `code` uniqueness within (tenantId, propertyId): repo provides
 *      `existsByCode` so service can guard on create.
 *
 * `seasonalTagsJson` stored as Utf8 JSON-stringified; validated on read
 * via `addonSeasonalTagSchema` (defense-in-depth — same pattern as
 * descriptions repo).
 */

import {
	type Addon,
	type AddonCategory,
	type AddonCreateInput,
	type AddonInventoryMode,
	type AddonPatch,
	type AddonPricingUnit,
	addonSeasonalTagSchema,
} from '@horeca/shared'
import { z } from 'zod'
import type { sql as SQL } from '../../db/index.ts'
import { NULL_INT32, textOpt, toTs } from '../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

const seasonalTagsArraySchema = z.array(addonSeasonalTagSchema)

type AddonDbRow = {
	tenantId: string
	propertyId: string
	addonId: string
	code: string
	category: string
	nameRu: string
	nameEn: string | null
	descriptionRu: string | null
	descriptionEn: string | null
	pricingUnit: string
	priceMicros: bigint | number
	currency: string
	vatBps: number | bigint
	isActive: boolean
	isMandatory: boolean
	inventoryMode: string
	dailyCapacity: number | bigint | null
	seasonalTagsJson: string
	sortOrder: number | bigint
	createdAt: Date
	updatedAt: Date
}

function rowToAddon(r: AddonDbRow): Addon {
	let seasonalTags: ReturnType<typeof seasonalTagsArraySchema.parse>
	try {
		seasonalTags = seasonalTagsArraySchema.parse(JSON.parse(r.seasonalTagsJson))
	} catch (err) {
		throw new Error(
			`Corrupt seasonalTagsJson for tenantId=${r.tenantId} addonId=${r.addonId}: ${(err as Error).message}`,
		)
	}
	return {
		tenantId: r.tenantId,
		propertyId: r.propertyId,
		addonId: r.addonId,
		code: r.code,
		category: r.category as AddonCategory,
		nameRu: r.nameRu,
		nameEn: r.nameEn,
		descriptionRu: r.descriptionRu,
		descriptionEn: r.descriptionEn,
		pricingUnit: r.pricingUnit as AddonPricingUnit,
		priceMicros: typeof r.priceMicros === 'bigint' ? r.priceMicros : BigInt(r.priceMicros),
		currency: r.currency as Addon['currency'],
		vatBps: Number(r.vatBps),
		isActive: r.isActive,
		isMandatory: r.isMandatory,
		inventoryMode: r.inventoryMode as AddonInventoryMode,
		dailyCapacity: r.dailyCapacity === null ? null : Number(r.dailyCapacity),
		seasonalTags,
		sortOrder: Number(r.sortOrder),
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
	}
}

export interface ListAddonsFilter {
	readonly category?: AddonCategory
	readonly onlyActive?: boolean
}

export function createAddonsRepo(sql: SqlInstance) {
	return {
		async listByProperty(
			tenantId: string,
			propertyId: string,
			filter: ListAddonsFilter = {},
		): Promise<Addon[]> {
			const [rows = []] = await sql<AddonDbRow[]>`
				SELECT *
				FROM propertyAddon
				WHERE tenantId = ${tenantId} AND propertyId = ${propertyId}
				ORDER BY sortOrder, code
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			let mapped = rows.map(rowToAddon)
			if (filter.category !== undefined) {
				mapped = mapped.filter((a) => a.category === filter.category)
			}
			if (filter.onlyActive === true) {
				mapped = mapped.filter((a) => a.isActive)
			}
			return mapped
		},

		async getById(tenantId: string, propertyId: string, addonId: string): Promise<Addon | null> {
			const [rows = []] = await sql<AddonDbRow[]>`
				SELECT *
				FROM propertyAddon
				WHERE tenantId = ${tenantId}
				  AND propertyId = ${propertyId}
				  AND addonId = ${addonId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToAddon(row) : null
		},

		/** Used by service to guard `code` uniqueness within a property. */
		async existsByCode(tenantId: string, propertyId: string, code: string): Promise<boolean> {
			const [rows = []] = await sql<{ x: number }[]>`
				SELECT 1 AS x
				FROM propertyAddon
				WHERE tenantId = ${tenantId}
				  AND propertyId = ${propertyId}
				  AND code = ${code}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.length > 0
		},

		async create(
			tenantId: string,
			propertyId: string,
			addonId: string,
			input: AddonCreateInput,
			actorId: string,
		): Promise<Addon> {
			const now = new Date()
			const nowTs = toTs(now)
			const seasonalTagsJson = JSON.stringify(input.seasonalTags)
			const nameEn = input.nameEn ?? null
			const descriptionRu = input.descriptionRu ?? null
			const descriptionEn = input.descriptionEn ?? null
			const dailyCapacity = input.dailyCapacity ?? null
			await sql`
				UPSERT INTO propertyAddon (
					\`tenantId\`, \`propertyId\`, \`addonId\`,
					\`code\`, \`category\`,
					\`nameRu\`, \`nameEn\`, \`descriptionRu\`, \`descriptionEn\`,
					\`pricingUnit\`, \`priceMicros\`, \`currency\`, \`vatBps\`,
					\`isActive\`, \`isMandatory\`,
					\`inventoryMode\`, \`dailyCapacity\`,
					\`seasonalTagsJson\`, \`sortOrder\`,
					\`createdAt\`, \`createdBy\`, \`updatedAt\`, \`updatedBy\`
				) VALUES (
					${tenantId}, ${propertyId}, ${addonId},
					${input.code}, ${input.category},
					${input.nameRu}, ${textOpt(nameEn)}, ${textOpt(descriptionRu)}, ${textOpt(descriptionEn)},
					${input.pricingUnit}, ${input.priceMicros}, ${input.currency}, ${input.vatBps},
					${input.isActive}, ${input.isMandatory},
					${input.inventoryMode}, ${dailyCapacity ?? NULL_INT32},
					${seasonalTagsJson}, ${input.sortOrder},
					${nowTs}, ${actorId}, ${nowTs}, ${actorId}
				)
			`
			return {
				tenantId,
				propertyId,
				addonId,
				code: input.code,
				category: input.category,
				nameRu: input.nameRu,
				nameEn,
				descriptionRu,
				descriptionEn,
				pricingUnit: input.pricingUnit,
				priceMicros: input.priceMicros,
				currency: input.currency,
				vatBps: input.vatBps,
				isActive: input.isActive,
				isMandatory: input.isMandatory,
				inventoryMode: input.inventoryMode,
				dailyCapacity,
				seasonalTags: input.seasonalTags,
				sortOrder: input.sortOrder,
				createdAt: now.toISOString(),
				updatedAt: now.toISOString(),
			}
		},

		async patch(
			tenantId: string,
			propertyId: string,
			addonId: string,
			input: AddonPatch,
			actorId: string,
		): Promise<Addon | null> {
			return sql.begin(async (tx) => {
				const [rows = []] = await tx<AddonDbRow[]>`
					SELECT *
					FROM propertyAddon
					WHERE tenantId = ${tenantId}
					  AND propertyId = ${propertyId}
					  AND addonId = ${addonId}
					LIMIT 1
				`
				const row = rows[0]
				if (!row) return null
				const current = rowToAddon(row)
				const merged: Addon = {
					...current,
					code: input.code ?? current.code,
					category: input.category ?? current.category,
					nameRu: input.nameRu ?? current.nameRu,
					nameEn: 'nameEn' in input && input.nameEn !== undefined ? input.nameEn : current.nameEn,
					descriptionRu:
						'descriptionRu' in input && input.descriptionRu !== undefined
							? input.descriptionRu
							: current.descriptionRu,
					descriptionEn:
						'descriptionEn' in input && input.descriptionEn !== undefined
							? input.descriptionEn
							: current.descriptionEn,
					pricingUnit: input.pricingUnit ?? current.pricingUnit,
					priceMicros: input.priceMicros ?? current.priceMicros,
					currency: input.currency ?? current.currency,
					vatBps: input.vatBps ?? current.vatBps,
					isActive: input.isActive ?? current.isActive,
					isMandatory: input.isMandatory ?? current.isMandatory,
					inventoryMode: input.inventoryMode ?? current.inventoryMode,
					dailyCapacity:
						'dailyCapacity' in input && input.dailyCapacity !== undefined
							? input.dailyCapacity
							: current.dailyCapacity,
					seasonalTags: input.seasonalTags ?? current.seasonalTags,
					sortOrder: input.sortOrder ?? current.sortOrder,
					updatedAt: new Date().toISOString(),
				}
				const now = new Date(merged.updatedAt)
				await tx`
					UPDATE propertyAddon SET
						code = ${merged.code},
						category = ${merged.category},
						nameRu = ${merged.nameRu},
						nameEn = ${textOpt(merged.nameEn)},
						descriptionRu = ${textOpt(merged.descriptionRu)},
						descriptionEn = ${textOpt(merged.descriptionEn)},
						pricingUnit = ${merged.pricingUnit},
						priceMicros = ${merged.priceMicros},
						currency = ${merged.currency},
						vatBps = ${merged.vatBps},
						isActive = ${merged.isActive},
						isMandatory = ${merged.isMandatory},
						inventoryMode = ${merged.inventoryMode},
						dailyCapacity = ${merged.dailyCapacity ?? NULL_INT32},
						seasonalTagsJson = ${JSON.stringify(merged.seasonalTags)},
						sortOrder = ${merged.sortOrder},
						updatedAt = ${toTs(now)},
						updatedBy = ${actorId}
					WHERE tenantId = ${tenantId}
					  AND propertyId = ${propertyId}
					  AND addonId = ${addonId}
				`
				return merged
			})
		},

		async delete(tenantId: string, propertyId: string, addonId: string): Promise<boolean> {
			const [rows = []] = await sql<{ x: number }[]>`
				SELECT 1 AS x
				FROM propertyAddon
				WHERE tenantId = ${tenantId}
				  AND propertyId = ${propertyId}
				  AND addonId = ${addonId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			if (rows.length === 0) return false
			await sql`
				DELETE FROM propertyAddon
				WHERE tenantId = ${tenantId}
				  AND propertyId = ${propertyId}
				  AND addonId = ${addonId}
			`
			return true
		},
	}
}
