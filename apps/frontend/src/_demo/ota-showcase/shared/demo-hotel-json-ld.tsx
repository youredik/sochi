/**
 * Round 13 — JSON-LD AI markers component for demo property pages.
 *
 * Canon: `project_2026_grade_architecture_canon_2026_05_25.md` §«AI-readable
 * inventory» — Lake.com captured 47% AI mention share via schema.org/Hotel +
 * OpenTravel 2.0 markers + SearchAction. For Sepshn demo, this puts trademark-
 * safe «approximate-not-exact» branded pages в the canonical AI-discoverable
 * shape.
 *
 * Strategy — runtime-rendered `<script type="application/ld+json">` в the React
 * tree. React 19 supports unsafe script inserts via `dangerouslySetInnerHTML`.
 * Modern AI crawlers (GPTBot, ClaudeBot, GoogleBot) execute JS — runtime
 * injection is sufficient. For pre-rendered AI agents, Phase-2 would add SSR
 * с baked-in JSON-LD; demo runtime path acceptable until then.
 *
 * Sibling-sweep — `renderHotelJsonLdScript` в `apps/backend/src/lib/json-ld`
 * is server-side equivalent for production widget iframes (M9.widget.8). This
 * component intentionally duplicates the shape (~30 lines) instead of importing
 * cross-process: frontend bundle should not pull backend code. Both must drift
 * together when schema updates land.
 */

import type { DemoOtaBrand } from './demo-disclaimer-banner.tsx'

export interface DemoHotelJsonLdProps {
	readonly brand: DemoOtaBrand
	readonly propertyId: string
	readonly checkIn: string
	readonly checkOut: string
	readonly totalPriceRub: number
	readonly roomName: string
}

/**
 * Escape JSON for safe HTML `<script>` embed. Same algorithm as backend
 * `hotel-schema.ts` `escapeForHtmlScript` (canon D7 XSS defense). Frontend
 * mirror because demo data is inlined client-side и must escape identically.
 */
function escapeForHtmlScript(json: string): string {
	const u2028 = new RegExp(String.fromCharCode(0x2028), 'g')
	const u2029 = new RegExp(String.fromCharCode(0x2029), 'g')
	return json
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026')
		.replace(u2028, '\\u2028')
		.replace(u2029, '\\u2029')
}

export function DemoHotelJsonLd({
	brand,
	propertyId,
	checkIn,
	checkOut,
	totalPriceRub,
	roomName,
}: DemoHotelJsonLdProps) {
	const schema = {
		'@context': 'https://schema.org',
		'@type': 'Hotel',
		name: 'Гостевой дом «Сэпшн-демо» в Сочи',
		description: 'Демонстрационный гостевой дом для презентации Sepshn PMS. Все данные тестовые.',
		address: {
			'@type': 'PostalAddress',
			streetAddress: 'ул. Демонстрационная, д. 1',
			addressLocality: 'Сочи',
			addressRegion: 'Краснодарский край',
			postalCode: '354000',
			addressCountry: 'RU',
		},
		geo: {
			'@type': 'GeoCoordinates',
			latitude: 43.5855,
			longitude: 39.7231,
		},
		telephone: '+70000000001',
		starRating: { '@type': 'Rating', ratingValue: 3 },
		priceRange: '₽₽',
		numberOfRooms: 8,
		image: [],
		containsPlace: [
			{
				'@type': 'HotelRoom',
				name: roomName,
				bed: { '@type': 'BedDetails', numberOfBeds: 2, typeOfBed: 'Queen' },
				occupancy: { '@type': 'QuantitativeValue', maxValue: 2 },
				offers: {
					'@type': 'Offer',
					priceCurrency: 'RUB',
					price: totalPriceRub,
					availability: 'https://schema.org/InStock',
					validFrom: checkIn,
					validThrough: checkOut,
				},
			},
		],
		// Canon: Lake.com — AI-readable markers. `aiCompatibility` is a Sepshn
		// extension namespace; «alisaSearchable» signals RU-language AI agents
		// (Yandex Алиса / GigaChat) that this page is canonical for Hotel
		// дискавер. `lastUpdatedIso` lets agents оценить freshness.
		aiCompatibility: {
			alisaSearchable: true,
			gptBotIndexable: true,
			lastUpdatedIso: new Date().toISOString(),
		},
		// OpenTravel 2.0 reference (canon Round 8 P1-3 + RU-unique moat #1):
		// stable property code for AI agent dereferencing across sessions.
		'sepshn:ota2026PropertyCode': `${brand}.${propertyId}`,
		// SearchAction enables «потенциальный гость → AI agent → SearchAction
		// для prefilled query» bookmark surface. Canon Lake.com.
		potentialAction: {
			'@type': 'SearchAction',
			target: {
				'@type': 'EntryPoint',
				urlTemplate: `https://demo.sepshn.ru/demo/ota/${brand}/property/${propertyId}?checkIn={checkin_date}&checkOut={checkout_date}`,
			},
			'query-input': ['required name=checkin_date', 'required name=checkout_date'],
		},
	}
	const json = escapeForHtmlScript(JSON.stringify(schema))
	return (
		<script
			type="application/ld+json"
			data-testid="demo-hotel-json-ld"
			// React 19 supports inline script content via dangerouslySetInnerHTML.
			// Content already XSS-escaped via escapeForHtmlScript per canon D7.
			// biome-ignore lint/security/noDangerouslySetInnerHtml: D7 XSS-escape applied + JSON-LD canonical pattern
			dangerouslySetInnerHTML={{ __html: json }}
		/>
	)
}
