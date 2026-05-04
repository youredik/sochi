/**
 * Demo-tenant JSON-LD augments — M9.widget.8 / A6.1.
 *
 * Per `plans/m9_widget_8_canonical.md` §1: «Same код для demo + production
 * tenants — mode-flag NO влияет на seed-quality». For production tenants,
 * canonical augments (geo / starRating / photo CDN URLs / postal code /
 * region) come from M11+ admin-UI fields. Until then, demo tenant ships
 * hard-coded canonical Сириус values + production tenants degrade gracefully
 * (minimal Hotel JSON-LD без `image[]`/`geo`/`starRating`).
 *
 * Lookup keyed by `tenantSlug`. Values for demo tenants only.
 */

import type { HotelSchemaInput } from './hotel-schema.ts'

/**
 * Augments overlay onto property+roomTypes from DB — fields NOT в schema yet.
 * Sub-set of `HotelSchemaInput` (omitting fields derived from DB query).
 */
export type HotelAugments = Pick<
	HotelSchemaInput,
	| 'description'
	| 'starRating'
	| 'priceRange'
	| 'images'
	| 'checkinTime'
	| 'checkoutTime'
	| 'telephone'
> & {
	readonly addressRegion: string
	readonly postalCode: string
	readonly addressCountry: string
	readonly geo: { readonly latitude: number; readonly longitude: number }
}

const DEMO_AUGMENTS: Map<string, HotelAugments> = new Map([
	[
		'demo-sirius',
		{
			description:
				'Семейная гостиница на 24 номера в федеральной территории Сириус, Сочи. Море, набережная, Олимпийский парк — в шаговой доступности. Завтрак включён.',
			starRating: 4,
			priceRange: '4500–9500 ₽',
			// Picsum.photos seeded URLs — royalty-free CC0, deterministic, ≥1200px
			// per Google Hotel rich-results spec. Production tenants get S3 CDN
			// URLs from M11+ admin UI photo upload.
			images: [
				'https://picsum.photos/seed/sirius-facade/1200/800',
				'https://picsum.photos/seed/sirius-lobby/1200/800',
				'https://picsum.photos/seed/sirius-deluxe/1200/800',
				'https://picsum.photos/seed/sirius-standard/1200/800',
				'https://picsum.photos/seed/sirius-restaurant/1200/800',
			],
			checkinTime: '14:00',
			checkoutTime: '12:00',
			telephone: '+78622000000', // E.164 placeholder until M11 admin-UI publicPhone column
			addressRegion: 'Краснодарский край',
			postalCode: '354340', // Сириус/Адлер 6-digit RU postal
			addressCountry: 'RU', // ISO-2 (D2)
			geo: { latitude: 43.4178, longitude: 39.9493 }, // Sirius coords
		},
	],
])

/**
 * Resolve augments for a tenant slug. Returns null if no augments registered
 * (production tenants pre-M11 admin-UI). Caller composes minimal Hotel JSON-LD
 * без augment-derived fields.
 */
export function getDemoAugments(tenantSlug: string): HotelAugments | null {
	return DEMO_AUGMENTS.get(tenantSlug) ?? null
}

/**
 * Test-only seam: register a slug under the canonical Сириус augments. Used
 * by integration tests that need a JSON-LD render against a unique-slug fixture
 * without colliding на UNIQUE-slug constraint с the real `demo-sirius` seed.
 *
 * @returns disposer function — call to unregister the slug на teardown.
 */
export function registerDemoAugmentForTest(slug: string): () => void {
	const sirius = DEMO_AUGMENTS.get('demo-sirius')
	if (!sirius) throw new Error('registerDemoAugmentForTest: demo-sirius missing from canonical map')
	DEMO_AUGMENTS.set(slug, sirius)
	return () => {
		DEMO_AUGMENTS.delete(slug)
	}
}
