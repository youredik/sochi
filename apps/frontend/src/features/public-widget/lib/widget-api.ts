/**
 * Typed API client для public booking widget endpoints.
 *
 * Matches `apps/backend/src/domains/widget/widget.routes.ts` shape.
 * No auth required — public surface, anonymous access.
 *
 * Per `plans/m9_widget_canonical.md` §M9.widget.1:
 *   - Read-only (M9.widget.1 MVP). Mutating endpoints (POST booking) — М9.widget.4.
 *   - TanStack Query staleTime 30s для cache-friendliness.
 *   - 404 → null sentinel (UI shows empty/not-found state).
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
}

export interface PublicWidgetPropertyView {
	readonly tenant: PublicWidgetTenant
	readonly properties: PublicProperty[]
}

export interface PublicWidgetPropertyDetail {
	readonly tenant: PublicWidgetTenant
	readonly property: PublicProperty
	readonly roomTypes: PublicRoomType[]
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
