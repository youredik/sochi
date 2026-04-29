/**
 * Widget service — orchestration over widget.repo + tenant-resolver.
 *
 * Public surface for booking widget — все methods принимают `tenantSlug`
 * (URL-supplied) и сами resolve'ят tenant. Методы возвращают public DTO
 * без internal IDs которые не должны утечь в HTTP response.
 *
 * Per `plans/m9_widget_canonical.md` §M9.widget.1: M9.widget.1 MVP scope =
 * только property + roomType list. Rate calc + availability merge + booking
 * lock — М9.widget.2 (Screen 1 search & pick) и М9.widget.4 (commit).
 */
import { resolveTenantBySlug } from '../../lib/tenant-resolver.ts'
import type { PublicProperty, PublicRoomType, WidgetRepo } from './widget.repo.ts'

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
}

export class TenantNotFoundError extends Error {
	readonly slug: string
	constructor(slug: string) {
		super(`Public widget tenant not found: '${slug}'`)
		this.name = 'TenantNotFoundError'
		this.slug = slug
	}
}

export class PublicPropertyNotFoundError extends Error {
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
			const roomTypes = await repo.listRoomTypesForProperty(resolved.tenantId, propertyId)
			return {
				tenant: { slug: resolved.slug, name: resolved.name, mode: resolved.mode },
				property,
				roomTypes,
			}
		},
	}
}

export type WidgetService = ReturnType<typeof createWidgetService>
