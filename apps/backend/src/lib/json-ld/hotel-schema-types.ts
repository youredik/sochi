/**
 * Shared types for Schema.org Hotel JSON-LD — M9.widget.8 / A6.1.
 *
 * Separate file (not inlined in `hotel-schema.ts`) to permit type-only imports
 * from frontend SPA route без pulling the renderer impl into the SPA bundle.
 */

export interface RoomTypeForJsonLd {
	readonly name: string
	readonly description: string
	readonly maxOccupancy: number
	readonly baseBeds: number
	readonly extraBeds: number
	/** Optional sq-m area (m²). */
	readonly areaSqm?: number
}
