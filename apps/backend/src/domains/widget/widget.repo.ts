/**
 * Widget repo — read-only public surface for the embeddable booking widget.
 *
 * Per `plans/m9_widget_canonical.md` §M9.widget.1:
 *   - Filter ALL queries `WHERE isPublic = true` — strict cross-tenant +
 *     cross-property isolation. Property с NULL/false isPublic не утечёт
 *     на /widget/{slug} endpoint.
 *   - tenantId is REQUIRED on every method — public route resolves slug
 *     to tenantId via `tenant-resolver.ts` before calling repo.
 *   - snapshotReadOnly + idempotent для cache-friendly reads.
 *
 * Out of scope для M9.widget.1: rate calc + availability merge live в
 * widget.service.ts (orchestration), здесь только sql-shaped queries.
 */
import { sql } from '../../db/index.ts'

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
		 */
		async listRoomTypesForProperty(
			tenantId: string,
			propertyId: string,
		): Promise<PublicRoomType[]> {
			const [rows = []] = await sqlInstance<RoomTypeRow[]>`
				SELECT id, propertyId, name, description, maxOccupancy, baseBeds
				FROM roomType
				WHERE tenantId = ${tenantId} AND propertyId = ${propertyId}
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
			}))
		},
	}
}

export type WidgetRepo = ReturnType<typeof createWidgetRepo>
