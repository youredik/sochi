/**
 * Widget service — orchestration over widget.repo + tenant-resolver.
 *
 * Public surface for booking widget — все methods принимают `tenantSlug`
 * (URL-supplied) и сами resolve'ят tenant. Методы возвращают public DTO
 * без internal IDs которые не должны утечь в HTTP response.
 *
 * Per `plans/m9_widget_canonical.md` §M9.widget.1-2:
 *   - listProperties / getPropertyDetail (M9.widget.1)
 *   - getAvailability (M9.widget.2) — search & pick screen orchestration:
 *     resolves tenant, validates property, filters roomTypes by occupancy,
 *     merges availability + rates + ratePlans, computes per-(roomType ×
 *     ratePlan) quote via `widget-pricing.ts` pure helpers.
 *
 * Booking lock + commit — М9.widget.4 (separate routes file).
 */
import type { AddonCategory, AddonInventoryMode, AddonPricingUnit } from '@horeca/shared'
import { resolveTenantBySlug } from '../../lib/tenant-resolver.ts'
import type {
	PublicAddon,
	PublicAvailabilityRow,
	PublicProperty,
	PublicPropertyPhoto,
	PublicRoomType,
	WidgetRepo,
} from './widget.repo.ts'
import {
	buildQuote,
	computeFreeCancelDeadline,
	enumerateNightDates,
	micrsToKopecks,
} from './widget-pricing.ts'

export interface PublicWidgetTenant {
	readonly slug: string
	readonly name: string
	readonly mode: 'demo' | 'production' | null
}

export interface PublicWidgetPropertyView {
	readonly tenant: PublicWidgetTenant
	readonly properties: PublicProperty[]
}

export interface PublicWidgetPropertyDetail {
	readonly tenant: PublicWidgetTenant
	readonly property: PublicProperty
	readonly roomTypes: PublicRoomType[]
	readonly photos: PublicPropertyPhoto[]
}

/**
 * Wire-format addon (priceMicros bigint → priceKopecks number, JSON-safe).
 * Per `plans/m9_widget_canonical.md` §3 R2 finding: client receives kopecks
 * to avoid bigint serialization (`JSON.stringify(bigint)` throws). Kopecks
 * fit Number.MAX_SAFE_INTEGER (~9 квадриллионов копеек = ~90 трлн ₽).
 */
export interface PublicWidgetAddon {
	readonly addonId: string
	readonly code: string
	readonly category: AddonCategory
	readonly nameRu: string
	readonly nameEn: string | null
	readonly descriptionRu: string | null
	readonly descriptionEn: string | null
	readonly pricingUnit: AddonPricingUnit
	readonly priceKopecks: number
	readonly currency: string
	readonly vatBps: number
	readonly inventoryMode: AddonInventoryMode
	readonly dailyCapacity: number | null
	readonly seasonalTags: readonly string[]
	readonly sortOrder: number
}

export interface PublicWidgetAddonsView {
	readonly tenant: PublicWidgetTenant
	readonly property: PublicProperty
	readonly addons: readonly PublicWidgetAddon[]
}

function publicAddonToWire(a: PublicAddon): PublicWidgetAddon {
	return {
		addonId: a.addonId,
		code: a.code,
		category: a.category,
		nameRu: a.nameRu,
		nameEn: a.nameEn,
		descriptionRu: a.descriptionRu,
		descriptionEn: a.descriptionEn,
		pricingUnit: a.pricingUnit,
		priceKopecks: micrsToKopecks(a.priceMicros),
		currency: a.currency,
		vatBps: a.vatBps,
		inventoryMode: a.inventoryMode,
		dailyCapacity: a.dailyCapacity,
		seasonalTags: a.seasonalTags,
		sortOrder: a.sortOrder,
	}
}

import { DomainError } from '../../errors/domain.ts'

/**
 * Widget tenant slug не зарегистрирован в `organization` table. Both legacy
 * (try-catch в widget.routes.ts) AND modern (onError → http-mapping `NOT_FOUND` → 404)
 * pathways supported. Per `feedback_engineering_philosophy.md` (по пути
 * совершенствуем) refactored from `Error` → `DomainError` 2026-04-30 для
 * consistent error handling across widget routes (booking-create.routes.ts
 * relies on auto-404 via onError + http-mapping).
 */
export class TenantNotFoundError extends DomainError {
	readonly code = 'NOT_FOUND'
	readonly slug: string
	constructor(slug: string) {
		super(`Public widget tenant not found: '${slug}'`)
		this.name = 'TenantNotFoundError'
		this.slug = slug
	}
}

export class PublicPropertyNotFoundError extends DomainError {
	readonly code = 'NOT_FOUND'
	readonly tenantSlug: string
	readonly propertyId: string
	constructor(tenantSlug: string, propertyId: string) {
		super(`Public property not found: tenant='${tenantSlug}' propertyId='${propertyId}'`)
		this.name = 'PublicPropertyNotFoundError'
		this.tenantSlug = tenantSlug
		this.propertyId = propertyId
	}
}

export function createWidgetService(repo: WidgetRepo) {
	return {
		/**
		 * List все public properties для tenant (resolved via slug).
		 * Throws TenantNotFoundError если slug не зарегистрирован.
		 */
		async listProperties(tenantSlug: string): Promise<PublicWidgetPropertyView> {
			const resolved = await resolveTenantBySlug(tenantSlug)
			if (!resolved) throw new TenantNotFoundError(tenantSlug)
			const properties = await repo.listPublicProperties(resolved.tenantId)
			return {
				tenant: { slug: resolved.slug, name: resolved.name, mode: resolved.mode },
				properties,
			}
		},

		/**
		 * Get public property + room types. Throws PublicPropertyNotFoundError
		 * если property не существует ИЛИ не public ИЛИ не active ИЛИ
		 * принадлежит другому tenant.
		 */
		async getPropertyDetail(
			tenantSlug: string,
			propertyId: string,
		): Promise<PublicWidgetPropertyDetail> {
			const resolved = await resolveTenantBySlug(tenantSlug)
			if (!resolved) throw new TenantNotFoundError(tenantSlug)
			const property = await repo.getPublicProperty(resolved.tenantId, propertyId)
			if (!property) throw new PublicPropertyNotFoundError(tenantSlug, propertyId)
			const [roomTypes, photos] = await Promise.all([
				repo.listRoomTypesForProperty(resolved.tenantId, propertyId),
				repo.listPhotosForProperty(resolved.tenantId, propertyId),
			])
			return {
				tenant: { slug: resolved.slug, name: resolved.name, mode: resolved.mode },
				property,
				roomTypes,
				photos,
			}
		},

		/**
		 * Screen 2 (Extras / Addons) — list addons available для property's public widget.
		 *
		 * Throws TenantNotFoundError / PublicPropertyNotFoundError (timing-safe 404)
		 * для consistency с listProperties / getPropertyDetail.
		 *
		 * Server-side filters in repo: isActive=true, isMandatory=false,
		 * inventoryMode != 'TIME_SLOT'. Client receives addons fully loaded;
		 * conditional UI (e.g. infant-cot only if children > 0) — frontend concern.
		 */
		async listAddons(tenantSlug: string, propertyId: string): Promise<PublicWidgetAddonsView> {
			const resolved = await resolveTenantBySlug(tenantSlug)
			if (!resolved) throw new TenantNotFoundError(tenantSlug)
			const property = await repo.getPublicProperty(resolved.tenantId, propertyId)
			if (!property) throw new PublicPropertyNotFoundError(tenantSlug, propertyId)
			const addons = await repo.listPublicAddons(resolved.tenantId, propertyId)
			return {
				tenant: { slug: resolved.slug, name: resolved.name, mode: resolved.mode },
				property,
				addons: addons.map(publicAddonToWire),
			}
		},

		/**
		 * Screen 1 search & pick — orchestration:
		 *   1. Resolve tenant + property (404 if not found / not public / wrong tenant)
		 *   2. Filter roomTypes by occupancy: maxOccupancy >= adults+children
		 *   3. Fetch availability rows + rates + ratePlans + photos в parallel
		 *   4. Compute per (roomType × ratePlan) quote:
		 *      - sum nightly rates
		 *      - apply tourism tax (property.tourismTaxRateBps)
		 *      - free-cancel deadline (от ratePlan.cancellationHours)
		 *      - sellable iff: every night has rate AND availability has remaining
		 *        capacity AND no stop-sell / closed-to-arrival on first night /
		 *        closed-to-departure on last night AND minStay/maxStay satisfied
		 *
		 * Validates date range + guest count в this method (defensive). Caller
		 * pre-validates via Zod, но service double-checks.
		 */
		async getAvailability(input: GetAvailabilityInput): Promise<PublicAvailabilityResponse> {
			const { tenantSlug, propertyId, checkIn, checkOut, adults, children } = input

			if (!Number.isInteger(adults) || adults < 1 || adults > 10) {
				throw new InvalidAvailabilityInputError(`adults must be 1..10: ${adults}`)
			}
			if (!Number.isInteger(children) || children < 0 || children > 6) {
				throw new InvalidAvailabilityInputError(`children must be 0..6: ${children}`)
			}
			const totalGuests = adults + children
			let nights: string[]
			try {
				nights = enumerateNightDates(checkIn, checkOut)
			} catch (err) {
				throw new InvalidAvailabilityInputError((err as Error).message)
			}
			if (nights.length > 30) {
				throw new InvalidAvailabilityInputError(`stay too long (max 30 nights): ${nights.length}`)
			}

			const resolved = await resolveTenantBySlug(tenantSlug)
			if (!resolved) throw new TenantNotFoundError(tenantSlug)
			const property = await repo.getPublicProperty(resolved.tenantId, propertyId)
			if (!property) throw new PublicPropertyNotFoundError(tenantSlug, propertyId)

			const [allRoomTypes, ratePlans, availabilityRows, photos] = await Promise.all([
				repo.listRoomTypesForProperty(resolved.tenantId, propertyId),
				repo.listRatePlansForProperty(resolved.tenantId, propertyId),
				repo.listAvailability(resolved.tenantId, propertyId, checkIn, checkOut),
				repo.listPhotosForProperty(resolved.tenantId, propertyId),
			])

			// Filter by occupancy. Industry canon (Mews/Apaleo): hide rooms that
			// cannot fit guests, не показывать «sold out» на каждом из них.
			const eligibleRoomTypes = allRoomTypes.filter((rt) => rt.maxOccupancy >= totalGuests)

			const rates = await repo.listRates(resolved.tenantId, propertyId, checkIn, checkOut)
			const validRatePlanIds = new Set(ratePlans.map((rp) => rp.id))

			// Index rates: roomTypeId × ratePlanId × date → amountMicros.
			// Filter to active ratePlans only (drops orphaned rate rows for
			// deactivated plans).
			const ratesByRoomTypeRatePlan = new Map<string, Map<string, bigint>>()
			for (const r of rates) {
				if (!validRatePlanIds.has(r.ratePlanId)) continue
				const key = `${r.roomTypeId}::${r.ratePlanId}`
				let perDate = ratesByRoomTypeRatePlan.get(key)
				if (!perDate) {
					perDate = new Map()
					ratesByRoomTypeRatePlan.set(key, perDate)
				}
				perDate.set(r.date, r.amountMicros)
			}

			// Index availability: roomTypeId × date → row
			const availByRoomTypeDate = new Map<string, Map<string, PublicAvailabilityRow>>()
			for (const a of availabilityRows) {
				let perDate = availByRoomTypeDate.get(a.roomTypeId)
				if (!perDate) {
					perDate = new Map()
					availByRoomTypeDate.set(a.roomTypeId, perDate)
				}
				perDate.set(a.date, a)
			}

			const taxBps = property.tourismTaxRateBps ?? 0

			// Compose quotes per (roomType × ratePlan)
			const offerings: PublicAvailabilityOffering[] = []
			for (const rt of eligibleRoomTypes) {
				const rtPlans = ratePlans.filter((rp) => rp.roomTypeId === rt.id)
				const availPerDate = availByRoomTypeDate.get(rt.id) ?? new Map()

				let inventoryRemaining = rt.inventoryCount
				let sellableInventory = true
				let unsellableReason: SellableReason | null = null
				const firstNight = nights[0]
				const lastNight = nights[nights.length - 1]
				if (firstNight === undefined || lastNight === undefined) {
					sellableInventory = false
					unsellableReason = 'no_nights'
				} else {
					for (const night of nights) {
						const a = availPerDate.get(night)
						if (!a) {
							sellableInventory = false
							unsellableReason = 'missing_availability'
							break
						}
						if (a.stopSell) {
							sellableInventory = false
							unsellableReason = 'stop_sell'
							break
						}
						if (night === firstNight && a.closedToArrival) {
							sellableInventory = false
							unsellableReason = 'closed_to_arrival'
							break
						}
						if (night === lastNight && a.closedToDeparture) {
							sellableInventory = false
							unsellableReason = 'closed_to_departure'
							break
						}
						const remaining = a.allotment - a.sold
						if (remaining <= 0) {
							sellableInventory = false
							unsellableReason = 'sold_out'
							break
						}
						if (remaining < inventoryRemaining) inventoryRemaining = remaining
					}
				}

				const rateOptions: PublicRateOption[] = []
				for (const rp of rtPlans) {
					if (rp.minStay > nights.length) continue
					if (rp.maxStay !== null && rp.maxStay < nights.length) continue
					const perDate = ratesByRoomTypeRatePlan.get(`${rt.id}::${rp.id}`)
					if (!perDate) continue
					const amounts: bigint[] = []
					let allDatesPriced = true
					for (const night of nights) {
						const amt = perDate.get(night)
						if (amt === undefined) {
							allDatesPriced = false
							break
						}
						amounts.push(amt)
					}
					if (!allDatesPriced) continue
					const quote = buildQuote(amounts, taxBps)
					const freeCancelDeadline = rp.isRefundable
						? computeFreeCancelDeadline(checkIn, rp.cancellationHours)
						: null
					rateOptions.push({
						ratePlanId: rp.id,
						code: rp.code,
						name: rp.name,
						isDefault: rp.isDefault,
						isRefundable: rp.isRefundable,
						mealsIncluded: rp.mealsIncluded,
						currency: rp.currency,
						subtotalKopecks: quote.subtotalKopecks,
						tourismTaxKopecks: quote.tourismTaxKopecks,
						totalKopecks: quote.totalKopecks,
						avgPerNightKopecks: Math.floor(quote.subtotalKopecks / nights.length),
						freeCancelDeadlineUtc: freeCancelDeadline,
					})
				}

				offerings.push({
					roomType: rt,
					sellable: sellableInventory && rateOptions.length > 0,
					unsellableReason: sellableInventory ? null : unsellableReason,
					inventoryRemaining: sellableInventory ? inventoryRemaining : 0,
					rateOptions,
				})
			}

			return {
				tenant: { slug: resolved.slug, name: resolved.name, mode: resolved.mode },
				property,
				checkIn,
				checkOut,
				nights: nights.length,
				adults,
				children,
				offerings,
				photos,
			}
		},
	}
}

export interface GetAvailabilityInput {
	readonly tenantSlug: string
	readonly propertyId: string
	readonly checkIn: string
	readonly checkOut: string
	readonly adults: number
	readonly children: number
}

export type SellableReason =
	| 'no_nights'
	| 'missing_availability'
	| 'stop_sell'
	| 'closed_to_arrival'
	| 'closed_to_departure'
	| 'sold_out'

export interface PublicRateOption {
	readonly ratePlanId: string
	readonly code: string
	readonly name: string
	readonly isDefault: boolean
	readonly isRefundable: boolean
	readonly mealsIncluded: 'none' | 'breakfast' | 'halfBoard' | 'fullBoard' | null
	readonly currency: string
	readonly subtotalKopecks: number
	readonly tourismTaxKopecks: number
	readonly totalKopecks: number
	readonly avgPerNightKopecks: number
	readonly freeCancelDeadlineUtc: string | null
}

export interface PublicAvailabilityOffering {
	readonly roomType: PublicRoomType
	readonly sellable: boolean
	readonly unsellableReason: SellableReason | null
	readonly inventoryRemaining: number
	readonly rateOptions: PublicRateOption[]
}

export interface PublicAvailabilityResponse {
	readonly tenant: PublicWidgetTenant
	readonly property: PublicProperty
	readonly checkIn: string
	readonly checkOut: string
	readonly nights: number
	readonly adults: number
	readonly children: number
	readonly offerings: PublicAvailabilityOffering[]
	readonly photos: PublicPropertyPhoto[]
}

export class InvalidAvailabilityInputError extends Error {
	readonly reason: string
	constructor(reason: string) {
		super(`Invalid availability input: ${reason}`)
		this.name = 'InvalidAvailabilityInputError'
		this.reason = reason
	}
}

// Re-export for typing in routes (and to keep widget-api.ts wire-compatible)
export type {
	PublicAvailabilityRow,
	PublicPropertyPhoto,
	PublicRatePlan,
	PublicRateRow,
} from './widget.repo.ts'

export type WidgetService = ReturnType<typeof createWidgetService>
