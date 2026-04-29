/**
 * Typed API client для public booking widget endpoints.
 *
 * Matches `apps/backend/src/domains/widget/widget.routes.ts` shape.
 * No auth required — public surface, anonymous access.
 *
 * Per `plans/m9_widget_canonical.md` §M9.widget.1-2:
 *   - Read-only. Mutating endpoints (POST booking) — М9.widget.4.
 *   - TanStack Query staleTime 30s для cache-friendliness.
 *   - 404 → null sentinel (UI shows empty/not-found state).
 *   - 422 (InvalidAvailabilityInputError) propagates как throw (UI surfaces
 *     to user; не cache'ится).
 */

export interface PublicWidgetTenant {
	readonly slug: string
	readonly name: string
	readonly mode: 'demo' | 'production' | null
}

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

export interface PublicWidgetPropertyView {
	readonly tenant: PublicWidgetTenant
	readonly properties: PublicProperty[]
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

export interface PublicWidgetPropertyDetail {
	readonly tenant: PublicWidgetTenant
	readonly property: PublicProperty
	readonly roomTypes: PublicRoomType[]
	readonly photos: PublicPropertyPhoto[]
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

export interface AvailabilityQuery {
	readonly tenantSlug: string
	readonly propertyId: string
	readonly checkIn: string
	readonly checkOut: string
	readonly adults: number
	readonly children: number
}

export class WidgetApiInputError extends Error {
	readonly reason: string
	constructor(reason: string) {
		super(`Widget API rejected input: ${reason}`)
		this.name = 'WidgetApiInputError'
		this.reason = reason
	}
}

const BASE = '/api/public/widget'

async function fetchPublic<T>(path: string): Promise<T | null> {
	const res = await fetch(`${BASE}${path}`, {
		method: 'GET',
		headers: { Accept: 'application/json' },
	})
	if (res.status === 404) return null
	if (!res.ok) {
		throw new Error(`Public widget API error: HTTP ${res.status} on ${path}`)
	}
	const body = (await res.json()) as { data: T }
	return body.data
}

export async function listPublicProperties(
	tenantSlug: string,
): Promise<PublicWidgetPropertyView | null> {
	return fetchPublic<PublicWidgetPropertyView>(`/${encodeURIComponent(tenantSlug)}/properties`)
}

export async function getPublicPropertyDetail(
	tenantSlug: string,
	propertyId: string,
): Promise<PublicWidgetPropertyDetail | null> {
	return fetchPublic<PublicWidgetPropertyDetail>(
		`/${encodeURIComponent(tenantSlug)}/properties/${encodeURIComponent(propertyId)}`,
	)
}

/**
 * Fetch availability — search & pick screen orchestration.
 * Returns null if 404 (tenant or property unknown).
 * Throws `WidgetApiInputError` if 422 (invalid date range / out-of-bounds guests).
 */
export async function fetchAvailability(
	q: AvailabilityQuery,
): Promise<PublicAvailabilityResponse | null> {
	const params = new URLSearchParams({
		checkIn: q.checkIn,
		checkOut: q.checkOut,
		adults: String(q.adults),
		children: String(q.children),
	})
	const url = `${BASE}/${encodeURIComponent(q.tenantSlug)}/properties/${encodeURIComponent(q.propertyId)}/availability?${params.toString()}`
	const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } })
	if (res.status === 404) return null
	if (res.status === 422) {
		const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
		throw new WidgetApiInputError(body.error?.message ?? 'invalid input')
	}
	if (!res.ok) {
		throw new Error(`Public widget availability error: HTTP ${res.status}`)
	}
	const body = (await res.json()) as { data: PublicAvailabilityResponse }
	return body.data
}
