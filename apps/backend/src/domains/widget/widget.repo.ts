/**
 * Widget repo — read-only public surface for the embeddable booking widget.
 *
 * Per `plans/m9_widget_canonical.md` §M9.widget.1-2:
 *   - Filter ALL queries `WHERE isPublic = true` — strict cross-tenant +
 *     cross-property isolation. Property с NULL/false isPublic не утечёт
 *     на /widget/{slug} endpoint.
 *   - tenantId is REQUIRED on every method — public route resolves slug
 *     to tenantId via `tenant-resolver.ts` before calling repo.
 *   - snapshotReadOnly + idempotent для cache-friendly reads.
 *
 * M9.widget.2 additions: rate plans + availability + rates + property media
 * (photos). All read-only; rate amounts in Int64 micros (per `0003_rate_int64_amount.sql`),
 * availability allotment/sold as Int32. Service layer composes results
 * с widget-pricing pure helpers.
 */
import {
	type AddonCategory,
	type AddonInventoryMode,
	type AddonPricingUnit,
	addonSeasonalTagSchema,
} from '@horeca/shared'
import { z } from 'zod'
import { sql } from '../../db/index.ts'
import { dateFromIso } from '../../db/ydb-helpers.ts'

const seasonalTagsArraySchema = z.array(addonSeasonalTagSchema)

export interface PublicProperty {
	readonly id: string
	readonly name: string
	readonly address: string
	readonly city: string
	readonly timezone: string
	readonly tourismTaxRateBps: number | null
}

export interface PublicRoomType {
	readonly id: string
	readonly propertyId: string
	readonly name: string
	readonly description: string | null
	readonly maxOccupancy: number
	readonly baseBeds: number
	readonly extraBeds: number
	readonly areaSqm: number | null
	readonly inventoryCount: number
}

type PropertyRow = {
	id: string
	name: string
	address: string
	city: string
	timezone: string
	tourismTaxRateBps: number | null
	isActive: boolean
	isPublic: boolean | null
}

type RoomTypeRow = {
	id: string
	propertyId: string
	name: string
	description: string | null
	maxOccupancy: number
	baseBeds: number
}

function rowToPublicProperty(r: PropertyRow): PublicProperty {
	return {
		id: r.id,
		name: r.name,
		address: r.address,
		city: r.city,
		timezone: r.timezone,
		tourismTaxRateBps: r.tourismTaxRateBps ?? null,
	}
}

export function createWidgetRepo(sqlInstance = sql) {
	return {
		/**
		 * List PUBLIC properties for tenant. Filters by isPublic=true AND isActive=true.
		 * NULL isPublic is treated as private (NOT exposed).
		 */
		async listPublicProperties(tenantId: string): Promise<PublicProperty[]> {
			const [rows = []] = await sqlInstance<PropertyRow[]>`
				SELECT id, name, address, city, timezone, tourismTaxRateBps, isActive, isPublic
				FROM property
				WHERE tenantId = ${tenantId} AND isPublic = ${true} AND isActive = ${true}
				ORDER BY name ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToPublicProperty)
		},

		/**
		 * Get a single public property by id. Returns null если property
		 * не существует ИЛИ isPublic != true ИЛИ isActive != true ИЛИ
		 * принадлежит другому tenant.
		 */
		async getPublicProperty(tenantId: string, propertyId: string): Promise<PublicProperty | null> {
			const [rows = []] = await sqlInstance<PropertyRow[]>`
				SELECT id, name, address, city, timezone, tourismTaxRateBps, isActive, isPublic
				FROM property
				WHERE tenantId = ${tenantId} AND id = ${propertyId}
				  AND isPublic = ${true} AND isActive = ${true}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToPublicProperty(row) : null
		},

		/**
		 * List room types for a public property. Caller MUST verify
		 * property is public via getPublicProperty before calling this.
		 *
		 * M9.widget.2: returns extra fields (extraBeds, areaSqm, inventoryCount,
		 * isActive) для guest-occupancy filtering + rate-card UI. Service-layer
		 * filter `isActive=true` + `maxOccupancy >= adults+children`.
		 */
		async listRoomTypesForProperty(
			tenantId: string,
			propertyId: string,
		): Promise<PublicRoomType[]> {
			const [rows = []] = await sqlInstance<RoomTypeFullRow[]>`
				SELECT id, propertyId, name, description, maxOccupancy, baseBeds,
				       extraBeds, areaSqm, inventoryCount, isActive
				FROM roomType
				WHERE tenantId = ${tenantId} AND propertyId = ${propertyId}
				  AND isActive = ${true}
				ORDER BY name ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map((r) => ({
				id: r.id,
				propertyId: r.propertyId,
				name: r.name,
				description: r.description ?? null,
				maxOccupancy: r.maxOccupancy,
				baseBeds: r.baseBeds,
				extraBeds: r.extraBeds,
				areaSqm: r.areaSqm ?? null,
				inventoryCount: r.inventoryCount,
			}))
		},

		/**
		 * List active rate plans for a property. Caller filters by `isActive=true`.
		 * Returns ordered by isDefault DESC (default plan first для choice arch.).
		 */
		async listRatePlansForProperty(
			tenantId: string,
			propertyId: string,
		): Promise<PublicRatePlan[]> {
			const [rows = []] = await sqlInstance<RatePlanRow[]>`
				SELECT id, propertyId, roomTypeId, name, code, isDefault, isRefundable,
				       cancellationHours, mealsIncluded, minStay, maxStay, currency
				FROM ratePlan
				WHERE tenantId = ${tenantId} AND propertyId = ${propertyId}
				  AND isActive = ${true}
				ORDER BY isDefault DESC, code ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map((r) => ({
				id: r.id,
				propertyId: r.propertyId,
				roomTypeId: r.roomTypeId,
				name: r.name,
				code: r.code,
				isDefault: r.isDefault,
				isRefundable: r.isRefundable,
				cancellationHours: r.cancellationHours ?? null,
				mealsIncluded: (r.mealsIncluded ?? null) as PublicRatePlan['mealsIncluded'],
				minStay: r.minStay,
				maxStay: r.maxStay ?? null,
				currency: r.currency,
			}))
		},

		/**
		 * List availability (allotment + sold + restrictions) для a date range.
		 * Returns rows where `tenantId × propertyId × roomTypeId × date` exists.
		 * Missing dates = no row → service treats as «not sellable».
		 *
		 * Date range bounded inclusive: [checkIn, checkOut). Caller pre-validates.
		 */
		async listAvailability(
			tenantId: string,
			propertyId: string,
			checkInIso: string,
			checkOutIso: string,
		): Promise<PublicAvailabilityRow[]> {
			const [rows = []] = await sqlInstance<AvailabilityDbRow[]>`
				SELECT roomTypeId, date, allotment, sold, minStay, maxStay,
				       closedToArrival, closedToDeparture, stopSell
				FROM availability
				WHERE tenantId = ${tenantId} AND propertyId = ${propertyId}
				  AND date >= ${dateFromIso(checkInIso)} AND date < ${dateFromIso(checkOutIso)}
				ORDER BY roomTypeId ASC, date ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map((r) => ({
				roomTypeId: r.roomTypeId,
				date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date),
				allotment: r.allotment,
				sold: r.sold,
				minStay: r.minStay ?? null,
				maxStay: r.maxStay ?? null,
				closedToArrival: r.closedToArrival,
				closedToDeparture: r.closedToDeparture,
				stopSell: r.stopSell,
			}))
		},

		/**
		 * List per-date rate amounts (Int64 micros) for a property + date range.
		 * Returns ALL rates for the property in the range (typically ≤200 rows
		 * — 4 ratePlans × 30 nights × 2 roomTypes). Service layer filters by
		 * the ratePlan set it cares about. Avoids `IN $array` parameter binding
		 * which @ydbjs/query 6.x doesn't support (no list-bind helper в SDK).
		 */
		async listRates(
			tenantId: string,
			propertyId: string,
			checkInIso: string,
			checkOutIso: string,
		): Promise<PublicRateRow[]> {
			const [rows = []] = await sqlInstance<RateDbRow[]>`
				SELECT roomTypeId, ratePlanId, date, amountMicros, currency
				FROM rate
				WHERE tenantId = ${tenantId} AND propertyId = ${propertyId}
				  AND date >= ${dateFromIso(checkInIso)} AND date < ${dateFromIso(checkOutIso)}
				ORDER BY ratePlanId ASC, date ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map((r) => ({
				roomTypeId: r.roomTypeId,
				ratePlanId: r.ratePlanId,
				date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date),
				amountMicros: typeof r.amountMicros === 'bigint' ? r.amountMicros : BigInt(r.amountMicros),
				currency: r.currency,
			}))
		},

		/**
		 * List public photos for property + room types. Filters `derivedReady=true`
		 * (operator may have uploaded raw, not yet processed — hidden from widget
		 * per 0030 schema canon). NO cross-tenant leak.
		 */
		/**
		 * List public addons (extras) для property — server-side compliance filters:
		 *
		 *   - `isActive=true`: operator-controlled visibility
		 *   - `isMandatory=false`: mandatory addons are folded into rate quote, не на extras screen
		 *   - `inventoryMode != 'TIME_SLOT'`: TIME_SLOT (spa с time-slot picker) deferred
		 *     per `packages/shared/src/addons.ts` (M9.widget.3 plan §3 Round 2 finding)
		 *
		 * NOTE: opt-in mandate (ЗоЗПП ст. 16 ч. 3.1, 69-ФЗ от 07.04.2025) enforced
		 * at UI layer — server only filters which addons are *available* for selection.
		 */
		async listPublicAddons(tenantId: string, propertyId: string): Promise<PublicAddon[]> {
			const [rows = []] = await sqlInstance<AddonDbRow[]>`
				SELECT addonId, code, category, nameRu, nameEn, descriptionRu, descriptionEn,
				       pricingUnit, priceMicros, currency, vatBps, inventoryMode, dailyCapacity,
				       seasonalTagsJson, sortOrder
				FROM propertyAddon
				WHERE tenantId = ${tenantId} AND propertyId = ${propertyId}
				  AND isActive = ${true}
				  AND isMandatory = ${false}
				  AND inventoryMode != ${'TIME_SLOT'}
				ORDER BY sortOrder ASC, code ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToPublicAddon)
		},

		async listPhotosForProperty(
			tenantId: string,
			propertyId: string,
		): Promise<PublicPropertyPhoto[]> {
			const [rows = []] = await sqlInstance<PropertyMediaRow[]>`
				SELECT mediaId, roomTypeId, kind, originalKey, mimeType, widthPx, heightPx,
				       sortOrder, isHero, altRu, altEn, captionRu, captionEn
				FROM propertyMedia
				WHERE tenantId = ${tenantId} AND propertyId = ${propertyId}
				  AND derivedReady = ${true}
				ORDER BY isHero DESC, sortOrder ASC, mediaId ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map((r) => ({
				mediaId: r.mediaId,
				roomTypeId: r.roomTypeId ?? null,
				kind: r.kind,
				originalKey: r.originalKey,
				mimeType: r.mimeType,
				widthPx: r.widthPx,
				heightPx: r.heightPx,
				sortOrder: r.sortOrder,
				isHero: r.isHero,
				altRu: r.altRu,
				altEn: r.altEn ?? null,
				captionRu: r.captionRu ?? null,
				captionEn: r.captionEn ?? null,
			}))
		},
	}
}

export interface PublicRatePlan {
	readonly id: string
	readonly propertyId: string
	readonly roomTypeId: string
	readonly name: string
	readonly code: string
	readonly isDefault: boolean
	readonly isRefundable: boolean
	readonly cancellationHours: number | null
	readonly mealsIncluded: 'none' | 'breakfast' | 'halfBoard' | 'fullBoard' | null
	readonly minStay: number
	readonly maxStay: number | null
	readonly currency: string
}

export interface PublicAvailabilityRow {
	readonly roomTypeId: string
	readonly date: string
	readonly allotment: number
	readonly sold: number
	readonly minStay: number | null
	readonly maxStay: number | null
	readonly closedToArrival: boolean
	readonly closedToDeparture: boolean
	readonly stopSell: boolean
}

export interface PublicRateRow {
	readonly roomTypeId: string
	readonly ratePlanId: string
	readonly date: string
	readonly amountMicros: bigint
	readonly currency: string
}

export interface PublicPropertyPhoto {
	readonly mediaId: string
	readonly roomTypeId: string | null
	readonly kind: string
	readonly originalKey: string
	readonly mimeType: string
	readonly widthPx: number
	readonly heightPx: number
	readonly sortOrder: number
	readonly isHero: boolean
	readonly altRu: string
	readonly altEn: string | null
	readonly captionRu: string | null
	readonly captionEn: string | null
}

/**
 * Public addon row returned by `listPublicAddons`. Wire-format conversion
 * (priceMicros → priceKopecks) happens in the service layer; repo returns
 * canonical bigint micros to keep parity with rate/availability pattern.
 *
 * Excludes operator-only fields (isActive/isMandatory/createdAt/updatedAt/*By/
 * tenantId/propertyId) — caller pre-filters and tenant/property are
 * path-derived, no need to leak.
 */
export interface PublicAddon {
	readonly addonId: string
	readonly code: string
	readonly category: AddonCategory
	readonly nameRu: string
	readonly nameEn: string | null
	readonly descriptionRu: string | null
	readonly descriptionEn: string | null
	readonly pricingUnit: AddonPricingUnit
	readonly priceMicros: bigint
	readonly currency: string
	readonly vatBps: number
	readonly inventoryMode: AddonInventoryMode
	readonly dailyCapacity: number | null
	readonly seasonalTags: readonly string[]
	readonly sortOrder: number
}

type AddonDbRow = {
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
	inventoryMode: string
	dailyCapacity: number | bigint | null
	seasonalTagsJson: string
	sortOrder: number | bigint
}

function rowToPublicAddon(r: AddonDbRow): PublicAddon {
	let seasonalTags: ReturnType<typeof seasonalTagsArraySchema.parse>
	try {
		seasonalTags = seasonalTagsArraySchema.parse(JSON.parse(r.seasonalTagsJson))
	} catch (err) {
		throw new Error(`Corrupt seasonalTagsJson for addonId=${r.addonId}: ${(err as Error).message}`)
	}
	return {
		addonId: r.addonId,
		code: r.code,
		category: r.category as AddonCategory,
		nameRu: r.nameRu,
		nameEn: r.nameEn,
		descriptionRu: r.descriptionRu,
		descriptionEn: r.descriptionEn,
		pricingUnit: r.pricingUnit as AddonPricingUnit,
		priceMicros: typeof r.priceMicros === 'bigint' ? r.priceMicros : BigInt(r.priceMicros),
		currency: r.currency,
		vatBps: Number(r.vatBps),
		inventoryMode: r.inventoryMode as AddonInventoryMode,
		dailyCapacity: r.dailyCapacity === null ? null : Number(r.dailyCapacity),
		seasonalTags,
		sortOrder: Number(r.sortOrder),
	}
}

type RoomTypeFullRow = RoomTypeRow & {
	extraBeds: number
	areaSqm: number | null
	inventoryCount: number
	isActive: boolean
}

type RatePlanRow = {
	id: string
	propertyId: string
	roomTypeId: string
	name: string
	code: string
	isDefault: boolean
	isRefundable: boolean
	cancellationHours: number | null
	mealsIncluded: string | null
	minStay: number
	maxStay: number | null
	currency: string
}

type AvailabilityDbRow = {
	roomTypeId: string
	date: Date | string
	allotment: number
	sold: number
	minStay: number | null
	maxStay: number | null
	closedToArrival: boolean
	closedToDeparture: boolean
	stopSell: boolean
}

type RateDbRow = {
	roomTypeId: string
	ratePlanId: string
	date: Date | string
	amountMicros: bigint | number
	currency: string
}

type PropertyMediaRow = {
	mediaId: string
	roomTypeId: string | null
	kind: string
	originalKey: string
	mimeType: string
	widthPx: number
	heightPx: number
	sortOrder: number
	isHero: boolean
	altRu: string
	altEn: string | null
	captionRu: string | null
	captionEn: string | null
}

export type WidgetRepo = ReturnType<typeof createWidgetRepo>
