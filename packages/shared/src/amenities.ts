/**
 * Canonical amenity catalog.
 *
 * Per research/hotel-content-amenities-media.md §1.5 — internal codes are
 * **stable strings** (Expedia approach > OTA numeric). OTA/Booking/Expedia
 * mappings live in this file (git-versioned), NOT in the DB. Reasons:
 *
 *   1. Codelist evolution: Booking.com периодически добавляет коды (5xxx
 *      series) и retires legacy. Diff в коде через PR — observable;
 *      diff в DB — silent.
 *   2. Distribution adapters (M8.C channel managers) читают этот же
 *      catalog → одна точка правды.
 *   3. No N+1 lookups при выгрузке ARI: всё в памяти.
 *
 * Sources for OTA codes (research §§1.2-1.3):
 *   - Booking.com **HAC** (Hotel Amenity Code) — property-level facility.
 *   - Booking.com **RMA** (Room Amenity) — room-level facility.
 *   - Expedia **EQC code** (string-symbolic).
 *   - OpenTravel Alliance **OTA Code List PRA / RMA**.
 *
 * Wi-Fi note: Booking.com интернет коды НЕ в HAC/RMA — выгружаются через
 * Internet Details API (атрибуты free/paid, in-room/public, type, speed).
 * Поэтому AMN_WIFI_* имеют OTA код null.
 */
import { z } from 'zod'

/** Amenity scope — at property level (lobby/grounds) vs at room level. */
export const amenityScopeValues = ['property', 'room'] as const
export const amenityScopeSchema = z.enum(amenityScopeValues)
export type AmenityScope = z.infer<typeof amenityScopeSchema>

/** Pricing model: free, paid, free for some guests (e.g. loyalty/upgrade). */
export const amenityFreePaidValues = ['free', 'paid', 'free_for_some'] as const
export const amenityFreePaidSchema = z.enum(amenityFreePaidValues)
export type AmenityFreePaid = z.infer<typeof amenityFreePaidSchema>

/**
 * Logical groupings. Match canonical OTA categories (Internet, Activities,
 * Food, Wellness, etc.). Used for grouped display in widget UI + filters.
 */
export const amenityCategoryValues = [
	'internet',
	'parking',
	'transport',
	'pool',
	'wellness',
	'fitness',
	'food',
	'kids',
	'pets',
	'view',
	'business',
	'accessibility',
	'comfort',
	'room_features',
	'kitchen',
	'general',
] as const
export const amenityCategorySchema = z.enum(amenityCategoryValues)
export type AmenityCategory = z.infer<typeof amenityCategorySchema>

/**
 * One canonical amenity definition. Shared by both property amenities (set
 * by hotel via admin UI) and room-type amenities (per UnitGroup).
 *
 * `defaultFreePaid` is what UI pre-fills; operator can override per-property
 * (free WiFi for guests vs paid WiFi for walk-ins). Stored override on
 * `propertyAmenity.freePaid`.
 */
export interface AmenityDefinition {
	readonly code: string
	readonly scope: AmenityScope
	readonly category: AmenityCategory
	readonly defaultFreePaid: AmenityFreePaid
	/** Booking.com HAC numeric code, or null if not in HAC list. */
	readonly otaHac: number | null
	/** Booking.com RMA numeric code (room-scope), or null. */
	readonly otaRma: number | null
	/** Expedia EQC string-symbolic code, or null. */
	readonly expedia: string | null
	/**
	 * Whether this amenity supports a measurable value (e.g. TV size, WiFi
	 * speed). When true, `propertyAmenity.value` may be set to a string.
	 */
	readonly supportsValue: boolean
	/** Russian short label for UI. */
	readonly labelRu: string
	/** English short label for UI. */
	readonly labelEn: string
}

/**
 * Canonical 56 amenities. Carefully curated to cover:
 *   - top-15 search filters used by Sochi/Krasnodar Krai region travellers
 *     (research/hotel-content-amenities-media.md §1.2 + region-specific:
 *     mountain/sea views, ski-storage, swimming pool, spa)
 *   - mandatory ПП-1951 disclosure points (accessibility, family rooms,
 *     non-smoking)
 *   - common OTA codelists (HAC top 100 covers ~95% of property amenities)
 *
 * Adding a new amenity:
 *   1. Pick a stable AMN_* code; capital snake-case; do NOT renumber.
 *   2. Map to OTA codes if available — search Booking codelist, Expedia EQC.
 *   3. Add to this list; add a test in amenities.test.ts that validates
 *      the new entry's OTA mapping doesn't collide with another code.
 *
 * Removing an amenity: NEVER remove a code that has been distributed to
 * any production tenant. Mark `deprecated: true` (future-proof field —
 * not yet added) and stop emitting in OTA distribution. Migration deletes
 * propertyAmenity rows referencing removed codes, but only after full audit.
 */
export const AMENITY_CATALOG: readonly AmenityDefinition[] = [
	// ─── Internet (5) ─────────────────────────────────────────────────────
	{
		code: 'AMN_WIFI_FREE_PUBLIC',
		scope: 'property',
		category: 'internet',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: 'PROPERTY_WIFI',
		supportsValue: false,
		labelRu: 'Бесплатный Wi-Fi в общих зонах',
		labelEn: 'Free Wi-Fi in common areas',
	},
	{
		code: 'AMN_WIFI_FREE_ROOM',
		scope: 'room',
		category: 'internet',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: 'ROOM_WIFI_INTERNET',
		supportsValue: false,
		labelRu: 'Бесплатный Wi-Fi в номере',
		labelEn: 'Free Wi-Fi in room',
	},
	{
		code: 'AMN_WIFI_PAID',
		scope: 'property',
		category: 'internet',
		defaultFreePaid: 'paid',
		otaHac: null,
		otaRma: null,
		expedia: 'PROPERTY_WIFI',
		supportsValue: false,
		labelRu: 'Wi-Fi за дополнительную плату',
		labelEn: 'Paid Wi-Fi',
	},
	{
		code: 'AMN_WIFI_HIGH_SPEED',
		scope: 'property',
		category: 'internet',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: true,
		labelRu: 'Высокоскоростной Wi-Fi (Мбит/с)',
		labelEn: 'High-speed Wi-Fi (Mbps)',
	},
	{
		code: 'AMN_WIRED_INTERNET_ROOM',
		scope: 'room',
		category: 'internet',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Проводной интернет в номере',
		labelEn: 'Wired internet in room',
	},

	// ─── Parking (4) ──────────────────────────────────────────────────────
	{
		code: 'AMN_PARKING_INDOOR_FREE',
		scope: 'property',
		category: 'parking',
		defaultFreePaid: 'free',
		otaHac: 53,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Бесплатная крытая парковка',
		labelEn: 'Free indoor parking',
	},
	{
		code: 'AMN_PARKING_INDOOR_PAID',
		scope: 'property',
		category: 'parking',
		defaultFreePaid: 'paid',
		otaHac: 53,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Платная крытая парковка',
		labelEn: 'Paid indoor parking',
	},
	{
		code: 'AMN_PARKING_OUTDOOR_FREE',
		scope: 'property',
		category: 'parking',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Бесплатная парковка на улице',
		labelEn: 'Free outdoor parking',
	},
	{
		code: 'AMN_PARKING_OUTDOOR_PAID',
		scope: 'property',
		category: 'parking',
		defaultFreePaid: 'paid',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Платная парковка на улице',
		labelEn: 'Paid outdoor parking',
	},

	// ─── Transport (3) ────────────────────────────────────────────────────
	{
		code: 'AMN_AIRPORT_SHUTTLE_FREE',
		scope: 'property',
		category: 'transport',
		defaultFreePaid: 'free',
		otaHac: 41,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Бесплатный трансфер из аэропорта',
		labelEn: 'Free airport shuttle',
	},
	{
		code: 'AMN_AIRPORT_SHUTTLE_PAID',
		scope: 'property',
		category: 'transport',
		defaultFreePaid: 'paid',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Платный трансфер из аэропорта',
		labelEn: 'Paid airport shuttle',
	},
	{
		code: 'AMN_SKI_SHUTTLE',
		scope: 'property',
		category: 'transport',
		defaultFreePaid: 'free_for_some',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Шаттл к горнолыжным склонам',
		labelEn: 'Ski shuttle',
	},

	// ─── Pool (3) ─────────────────────────────────────────────────────────
	{
		code: 'AMN_POOL_INDOOR',
		scope: 'property',
		category: 'pool',
		defaultFreePaid: 'free',
		otaHac: 5154,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Крытый бассейн',
		labelEn: 'Indoor pool',
	},
	{
		code: 'AMN_POOL_OUTDOOR',
		scope: 'property',
		category: 'pool',
		defaultFreePaid: 'free',
		otaHac: 5154,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Открытый бассейн',
		labelEn: 'Outdoor pool',
	},
	{
		code: 'AMN_POOL_HEATED',
		scope: 'property',
		category: 'pool',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Подогреваемый бассейн',
		labelEn: 'Heated pool',
	},

	// ─── Wellness (5) ─────────────────────────────────────────────────────
	{
		code: 'AMN_SPA_CENTER',
		scope: 'property',
		category: 'wellness',
		defaultFreePaid: 'paid',
		otaHac: 5044,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Спа-центр',
		labelEn: 'Spa centre',
	},
	{
		code: 'AMN_SAUNA',
		scope: 'property',
		category: 'wellness',
		defaultFreePaid: 'free',
		otaHac: 79,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Сауна',
		labelEn: 'Sauna',
	},
	{
		code: 'AMN_HAMMAM',
		scope: 'property',
		category: 'wellness',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Хаммам',
		labelEn: 'Hammam (Turkish bath)',
	},
	{
		code: 'AMN_HOT_TUB',
		scope: 'property',
		category: 'wellness',
		defaultFreePaid: 'free',
		otaHac: 55,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Джакузи',
		labelEn: 'Hot tub / Jacuzzi',
	},
	{
		code: 'AMN_MASSAGE',
		scope: 'property',
		category: 'wellness',
		defaultFreePaid: 'paid',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Массаж',
		labelEn: 'Massage',
	},

	// ─── Fitness (1) ──────────────────────────────────────────────────────
	{
		code: 'AMN_FITNESS_CENTER',
		scope: 'property',
		category: 'fitness',
		defaultFreePaid: 'free',
		otaHac: 35,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Фитнес-центр',
		labelEn: 'Fitness centre',
	},

	// ─── Food (5) ─────────────────────────────────────────────────────────
	{
		code: 'AMN_RESTAURANT',
		scope: 'property',
		category: 'food',
		defaultFreePaid: 'paid',
		otaHac: 76,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Ресторан',
		labelEn: 'Restaurant',
	},
	{
		code: 'AMN_BAR',
		scope: 'property',
		category: 'food',
		defaultFreePaid: 'paid',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Бар',
		labelEn: 'Bar',
	},
	{
		code: 'AMN_BREAKFAST_INCLUDED',
		scope: 'property',
		category: 'food',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Завтрак включён',
		labelEn: 'Breakfast included',
	},
	{
		code: 'AMN_BREAKFAST_EXTRA',
		scope: 'property',
		category: 'food',
		defaultFreePaid: 'paid',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Завтрак за дополнительную плату',
		labelEn: 'Breakfast available for an extra charge',
	},
	{
		code: 'AMN_ROOM_SERVICE_24H',
		scope: 'property',
		category: 'food',
		defaultFreePaid: 'paid',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Круглосуточное обслуживание номеров',
		labelEn: '24-hour room service',
	},

	// ─── Kids (3) ─────────────────────────────────────────────────────────
	{
		code: 'AMN_KIDS_CLUB',
		scope: 'property',
		category: 'kids',
		defaultFreePaid: 'free',
		otaHac: 5054,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Детский клуб',
		labelEn: "Kids' club",
	},
	{
		code: 'AMN_PLAYGROUND',
		scope: 'property',
		category: 'kids',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Детская площадка',
		labelEn: 'Playground',
	},
	{
		code: 'AMN_BABYSITTING',
		scope: 'property',
		category: 'kids',
		defaultFreePaid: 'paid',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Услуги няни',
		labelEn: 'Babysitting service',
	},

	// ─── Pets (2) ─────────────────────────────────────────────────────────
	{
		code: 'AMN_PETS_ALLOWED_FREE',
		scope: 'property',
		category: 'pets',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: 'PROPERTY_PET_FRIENDLY',
		supportsValue: false,
		labelRu: 'С животными можно (бесплатно)',
		labelEn: 'Pets allowed (free)',
	},
	{
		code: 'AMN_PETS_ALLOWED_PAID',
		scope: 'property',
		category: 'pets',
		defaultFreePaid: 'paid',
		otaHac: null,
		otaRma: null,
		expedia: 'PROPERTY_PET_FRIENDLY',
		supportsValue: true,
		labelRu: 'С животными можно (за плату, ₽/сутки)',
		labelEn: 'Pets allowed (extra charge per night)',
	},

	// ─── View — room scope (6) ────────────────────────────────────────────
	{
		code: 'AMN_VIEW_SEA',
		scope: 'room',
		category: 'view',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: 224,
		expedia: null,
		supportsValue: false,
		labelRu: 'Вид на море',
		labelEn: 'Sea view',
	},
	{
		code: 'AMN_VIEW_MOUNTAIN',
		scope: 'room',
		category: 'view',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: 223,
		expedia: null,
		supportsValue: false,
		labelRu: 'Вид на горы',
		labelEn: 'Mountain view',
	},
	{
		code: 'AMN_VIEW_CITY',
		scope: 'room',
		category: 'view',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: 5121,
		expedia: null,
		supportsValue: false,
		labelRu: 'Вид на город',
		labelEn: 'City view',
	},
	{
		code: 'AMN_VIEW_GARDEN',
		scope: 'room',
		category: 'view',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: 5110,
		expedia: null,
		supportsValue: false,
		labelRu: 'Вид на сад',
		labelEn: 'Garden view',
	},
	{
		code: 'AMN_VIEW_LAKE',
		scope: 'room',
		category: 'view',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: 5109,
		expedia: null,
		supportsValue: false,
		labelRu: 'Вид на озеро',
		labelEn: 'Lake view',
	},
	{
		code: 'AMN_VIEW_RIVER',
		scope: 'room',
		category: 'view',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: 5122,
		expedia: null,
		supportsValue: false,
		labelRu: 'Вид на реку',
		labelEn: 'River view',
	},

	// ─── Business (3) ─────────────────────────────────────────────────────
	{
		code: 'AMN_MEETING_ROOM',
		scope: 'property',
		category: 'business',
		defaultFreePaid: 'paid',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Переговорная',
		labelEn: 'Meeting room',
	},
	{
		code: 'AMN_CONFERENCE_HALL',
		scope: 'property',
		category: 'business',
		defaultFreePaid: 'paid',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Конференц-зал',
		labelEn: 'Conference hall',
	},
	{
		code: 'AMN_BUSINESS_CENTER',
		scope: 'property',
		category: 'business',
		defaultFreePaid: 'free_for_some',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Бизнес-центр',
		labelEn: 'Business centre',
	},

	// ─── Accessibility (3) — ПП-1951 mandatory disclosure ────────────────
	{
		code: 'AMN_ACCESSIBLE_ROOMS',
		scope: 'property',
		category: 'accessibility',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: 'PROPERTY_WHEELCHAIR_ACCESSIBLE',
		supportsValue: false,
		labelRu: 'Номера для МГН',
		labelEn: 'Accessible rooms',
	},
	{
		code: 'AMN_ELEVATOR',
		scope: 'property',
		category: 'accessibility',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Лифт',
		labelEn: 'Elevator',
	},
	{
		code: 'AMN_WHEELCHAIR_RAMP',
		scope: 'property',
		category: 'accessibility',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Пандус',
		labelEn: 'Wheelchair ramp',
	},

	// ─── Comfort (7) — incl. ПП-1951 mandatory ──────────────────────────
	{
		code: 'AMN_AC',
		scope: 'property',
		category: 'comfort',
		defaultFreePaid: 'free',
		otaHac: 5,
		// RMA mapping is room-scope only (RMA 2 ≈ room AC). Channel adapters
		// project property-scope AC to a per-roomType RMA entry when emitting
		// to Booking; we don't pollute property-scope row with RMA.
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Кондиционер',
		labelEn: 'Air conditioning',
	},
	{
		code: 'AMN_HEATING',
		scope: 'property',
		category: 'comfort',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Отопление',
		labelEn: 'Heating',
	},
	{
		code: 'AMN_FRONT_DESK_24H',
		scope: 'property',
		category: 'comfort',
		defaultFreePaid: 'free',
		otaHac: 1,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Круглосуточная стойка регистрации',
		labelEn: '24-hour front desk',
	},
	{
		code: 'AMN_NON_SMOKING_PROPERTY',
		scope: 'property',
		category: 'comfort',
		defaultFreePaid: 'free',
		otaHac: 198,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Запрет курения на территории',
		labelEn: 'Non-smoking property',
	},
	{
		code: 'AMN_TERRACE',
		scope: 'property',
		category: 'comfort',
		defaultFreePaid: 'free',
		otaHac: 5006,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Терраса',
		labelEn: 'Terrace',
	},
	{
		code: 'AMN_GARDEN',
		scope: 'property',
		category: 'comfort',
		defaultFreePaid: 'free',
		otaHac: 5005,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Сад',
		labelEn: 'Garden',
	},
	{
		code: 'AMN_FAMILY_ROOMS',
		scope: 'property',
		category: 'comfort',
		defaultFreePaid: 'free',
		otaHac: 5041,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Семейные номера',
		labelEn: 'Family rooms',
	},

	// ─── Room features (8) — room scope ──────────────────────────────────
	{
		code: 'AMN_BALCONY',
		scope: 'room',
		category: 'room_features',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: 5017,
		expedia: null,
		supportsValue: false,
		labelRu: 'Балкон',
		labelEn: 'Balcony',
	},
	{
		code: 'AMN_TV_FLAT',
		scope: 'room',
		category: 'room_features',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: 251,
		expedia: 'ROOM_TV',
		supportsValue: true,
		labelRu: 'Плоский ТВ (диагональ дюймов)',
		labelEn: 'Flat-panel TV (size in inches)',
	},
	{
		code: 'AMN_TV_SMART',
		scope: 'room',
		category: 'room_features',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Смарт-ТВ',
		labelEn: 'Smart TV',
	},
	{
		code: 'AMN_SAFE',
		scope: 'room',
		category: 'room_features',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: 92,
		expedia: null,
		supportsValue: false,
		labelRu: 'Сейф',
		labelEn: 'Safe',
	},
	{
		code: 'AMN_HAIRDRYER',
		scope: 'room',
		category: 'room_features',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: 50,
		expedia: null,
		supportsValue: false,
		labelRu: 'Фен',
		labelEn: 'Hairdryer',
	},
	{
		code: 'AMN_BATHROBE',
		scope: 'room',
		category: 'room_features',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Халат',
		labelEn: 'Bathrobe',
	},
	{
		code: 'AMN_TOILETRIES',
		scope: 'room',
		category: 'room_features',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Туалетные принадлежности',
		labelEn: 'Toiletries',
	},
	{
		code: 'AMN_SOUNDPROOF',
		scope: 'room',
		category: 'room_features',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Звукоизоляция',
		labelEn: 'Soundproof',
	},

	// ─── Kitchen (5) ──────────────────────────────────────────────────────
	{
		code: 'AMN_KITCHEN_FULL',
		scope: 'room',
		category: 'kitchen',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: 59,
		expedia: null,
		supportsValue: false,
		labelRu: 'Полностью оборудованная кухня',
		labelEn: 'Full kitchen',
	},
	{
		code: 'AMN_KITCHENETTE',
		scope: 'room',
		category: 'kitchen',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Мини-кухня',
		labelEn: 'Kitchenette',
	},
	{
		code: 'AMN_MICROWAVE',
		scope: 'room',
		category: 'kitchen',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: 68,
		expedia: null,
		supportsValue: false,
		labelRu: 'Микроволновая печь',
		labelEn: 'Microwave',
	},
	{
		code: 'AMN_MINIBAR',
		scope: 'room',
		category: 'kitchen',
		defaultFreePaid: 'paid',
		otaHac: null,
		otaRma: 69,
		expedia: null,
		supportsValue: false,
		labelRu: 'Мини-бар',
		labelEn: 'Minibar',
	},
	{
		code: 'AMN_REFRIGERATOR',
		scope: 'room',
		category: 'kitchen',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: 88,
		expedia: null,
		supportsValue: false,
		labelRu: 'Холодильник',
		labelEn: 'Refrigerator',
	},
	{
		code: 'AMN_COFFEE_MAKER',
		scope: 'room',
		category: 'kitchen',
		defaultFreePaid: 'free',
		otaHac: null,
		otaRma: null,
		expedia: null,
		supportsValue: false,
		labelRu: 'Кофемашина',
		labelEn: 'Coffee maker',
	},
] as const

/**
 * Set of all canonical codes — frozen at module load. Used at validation
 * boundary (Zod refinement) and by repo to reject unknown codes.
 */
export const AMENITY_CODE_SET: ReadonlySet<string> = new Set(AMENITY_CATALOG.map((a) => a.code))

/** Lookup by code. O(1) via Map built once. */
const AMENITY_BY_CODE: ReadonlyMap<string, AmenityDefinition> = new Map(
	AMENITY_CATALOG.map((a) => [a.code, a]),
)

export function getAmenity(code: string): AmenityDefinition | null {
	return AMENITY_BY_CODE.get(code) ?? null
}

export function isAmenityCode(code: string): boolean {
	return AMENITY_CODE_SET.has(code)
}

/**
 * Filter catalog by scope. Used by UI to split between property amenities
 * (general property) and room amenities (per UnitGroup) screens.
 */
export function amenitiesByScope(scope: AmenityScope): readonly AmenityDefinition[] {
	return AMENITY_CATALOG.filter((a) => a.scope === scope)
}

/**
 * Zod refinement: `code` must be in the canonical catalog. Use this as the
 * boundary check at Hono routes — protects DB from drift.
 */
export const amenityCodeSchema = z.string().refine(isAmenityCode, {
	message: 'Unknown amenity code (not in canonical catalog)',
})

/**
 * One assignment of an amenity to a property/room. `value` is non-null only
 * for amenities with `supportsValue=true`. Service layer enforces this
 * invariant (see `checkAmenityValueInvariant`).
 */
export const propertyAmenityRowSchema = z.object({
	tenantId: z.string(),
	propertyId: z.string(),
	amenityCode: amenityCodeSchema,
	scope: amenityScopeSchema,
	freePaid: amenityFreePaidSchema,
	value: z.string().max(200).nullable(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
})
export type PropertyAmenityRow = z.infer<typeof propertyAmenityRowSchema>

/**
 * Input to add or update an amenity assignment. `scope` is implied by
 * `amenityCode` (looked up via getAmenity().scope) — clients don't pass it.
 */
export const propertyAmenityInputSchema = z.object({
	amenityCode: amenityCodeSchema,
	freePaid: amenityFreePaidSchema,
	value: z.string().max(200).nullable().optional(),
})
export type PropertyAmenityInput = z.infer<typeof propertyAmenityInputSchema>

/**
 * Cross-field invariant: `value` may only be set when the amenity supports
 * a measurable value. Reject mismatches at service boundary.
 */
export function checkAmenityValueInvariant(input: PropertyAmenityInput): string | null {
	const def = getAmenity(input.amenityCode)
	if (def === null) {
		return `Unknown amenity code: ${input.amenityCode}`
	}
	const hasValue = input.value !== null && input.value !== undefined && input.value !== ''
	if (hasValue && !def.supportsValue) {
		return `Amenity ${input.amenityCode} does not support a measurable value`
	}
	if (!hasValue && def.supportsValue) {
		// Allow null/empty — value is optional even when supported (e.g. WiFi
		// без указания скорости — операторы часто не знают точное значение).
		return null
	}
	return null
}
