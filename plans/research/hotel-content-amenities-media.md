# Research: Hotel Content (Photos + Amenities + Descriptions + Location) Standards 2026

**Дата:** 2026-04-27
**Источник:** research-агент волны 2 (HTNG / OpenTravel / Booking.com / Expedia / Apaleo / Mews / ПП-1951 РФ / Yandex Cloud)
**Confidence:** High (OTA structures, Booking.com codes, ПП-1951), Medium (Apaleo Content REST API photos, ПП-1951 Приложение № 5 точные m²), Low (HTNG codelist coverage)

---

## 0. Главные находки

1. **OpenTravel Alliance (OTA)** — lingua franca для hospitality content interchange. Booking.com **deprecates OTA endpoint Dec 2024 → full sunset 31 Dec 2026** в пользу REST API, но **codelists (HAC, RMA, ITT, PIC) остаются**.
2. **ПП-1951 от 27.12.2024** — отменил ГОСТ Р 51185-2014. Обязательная классификация всех средств размещения. Deadline для входа в Реестр: **1 Sep 2025**. Штрафы 300-450к ₽ для ЮЛ.
3. **Yandex Cloud НЕ имеет** managed image-transformation сервиса (как Cloudinary). Pipeline: Object Storage + Cloud Functions + sharp/vips.
4. **WhatsApp Business + Telegram** — must для RU контактов; Instagram заблокирован, но useful для international.
5. **Schema.org JSON-LD** обязательно — AI assistants (ChatGPT, Gemini, Yandex Алиса, Perplexity) читают для разбора.

---

## 1. OTA-стандарты amenities 2026

### 1.1 OpenTravel Alliance

Канонический schema — **OTA_HotelDescriptiveContentNotifRQ** (XSD на opentravel.org).

Booking.com **deprecates OTA endpoint Dec 2024 → full sunset 31 Dec 2026** в пользу REST APIs. Но **codelists** остаются alive и используются SiteMinder, TravelClick, Apaleo, channel managers.

Ключевые OTA codelists:

| Codelist | Purpose | Scope |
|---|---|---|
| **HAC** | Hotel Amenity Codes | property-level |
| **RMA** | Room Amenity Type | room-level |
| **ITT** | Image Tag Type | media classification |
| **PIC** | Picture Category Code | media coarse category |
| **GRI** | Guest Room Info | room features |
| **HOC** | Hotel Category | star rating type |
| **MEAL** | Meal plans | rate plan attribute |

**Mapping internal taxonomy to OTA codelists is non-negotiable** для OTA distribution.

### 1.2 Booking.com — HAC + RMA + ITT codes (2014B baseline)

Sample HAC (property-level):

| HAC | Meaning |
|---|---|
| 1 | 24-hour front desk |
| 5 | Air conditioning |
| 35 / 5086 | Fitness centre |
| 41 | Free airport shuttle |
| 53 | Indoor parking |
| 55 | Hot tub |
| 76 | Restaurant |
| 79 | Sauna |
| 198 | Non-smoking rooms |
| 5005 | Garden |
| 5006 | Terrace |
| 5041 | Family rooms |
| 5044 | Spa & wellness centre |
| 5054 | Kids' club |
| 5154 | Swimming pool |

**⚠️ Gap:** **нет canonical HAC/RMA для Wi-Fi** в публичном Booking.com codes-hac/codes-rma listing — Wi-Fi handled через **Internet Details API** с атрибутами (free/paid, in-room vs public, type=WiFi/wired, speed).

Sample RMA (room-level):

| RMA | Meaning |
|---|---|
| 2 | Air conditioning |
| 50 | Hairdryer |
| 59 | Kitchen |
| 68 | Microwave |
| 69 | Minibar |
| 88 | Refrigerator |
| 92 | Safe |
| 251 | TV |
| 223 | Mountain view |
| 224 | Ocean view |
| 5017 | Balcony |
| 5037 | Patio |
| 5109 | Lake view |
| 5110 | Garden view |
| 5121 | City view |
| 5122 | River view |

ITT (Image Tag) sample:
- 3 = Property building, 7 = Restaurant, 10 = Facade/entrance, 13 = Bed, 153 = Bathroom, 157 = Balcony/Terrace, 158 = Kitchen, 173 = Whole-room photo, 199 = Bedroom, 248-256 = Views.

PIC (coarser):
- 1 = Exterior, 2 = Lobby, 3 = Pool, 4 = Restaurant, 5 = Health club, 6 = Guestroom, 12 = Spa, 13 = Bar, 21 = Room amenity, 22 = Property amenity.

### 1.3 Expedia EQC / Product API

Expedia использует **string-symbolic codes** + `code/detailCode/value` triple — более expressive чем OTA. Examples:

```
{ code: ROOM_WIFI_INTERNET,   detailCode: SURCHARGE }
{ code: ROOM_BATHTUB_TYPE,    detailCode: DEEP_SOAKING }
{ code: ROOM_TV,              detailCode: FLAT_PANEL }
{ code: ROOM_TV_SIZE,         value: "55" }
{ code: ROOM_RECENT_RENOVATION_YEAR, value: "2025" }
{ code: ROOM_PET_FRIENDLY }
```

Партиционирует amenities: public-area internet, on-site services, family, accessibility, business.

### 1.4 HTNG

HTNG публикует message specs вокруг payments, energy, distribution но **не публикует amenity codelists** distinct от OpenTravel. Translation: для amenity dictionary — OTA + Booking.com + Expedia.

### 1.5 Рекомендация для нашей внутренней taxonomy

```ts
amenity {
  code_internal: string  // 'AMN_WIFI_FREE_ROOM', 'AMN_AC', 'AMN_PARKING_INDOOR_FREE'
  code_ota_hac: number?  // 1, 5, 53, ...
  code_ota_rma: number?
  code_booking_top: number?
  code_expedia: string?
  scope: 'property' | 'room'
  free_paid: 'free' | 'paid' | 'free_for_some'
  value?: string  // для измеримых ("TV size", "WiFi speed")
}
```

Internal codes — **stable strings** (Expedia approach лучше OTA's numeric). Migration table to OTA+Booking+Expedia в коде (не DB) — git versioned.

---

## 2. Apaleo Content Model

Apaleo API splits content surface across:

- **Inventory API** (`/inventory/v1`) — `Property`, `UnitGroup` (= room type), `Unit` (= physical room).
- Property carries: `name, description, paymentTerms, timeMode, defaultCheckInTime, defaultCheckOutTime, location {addressLine1, postalCode, city, regionCode, countryCode}, currencyCode, timeZone, isArchived, bankAccount`.
- UnitGroup: `code, name, description, maxPersons, type (BedRoom|MeetingRoom|...), occupancy {minPersons, maxPersons, extraBeds}, memberOfRatePlans[]`.
- **Settings API** для amenities/services.
- **Custom Content / property images** — uploaded через Apaleo One UI (НЕ публичный Content REST endpoint). Programmatic photo management — limited (community confirmation).
- **Translation pattern**: any field с text accepts `?languages=all` → returns `{ "en":..., "ru":..., "de":... }`.

Apaleo deliberately keeps content thin и pushes channel-side enrichment к channel managers (SiteMinder, Cubilis, D-Edge).

**Lesson:** build content rich на нашей стороне, потом channel adapter projects to OTA codelists.

---

## 3. Mews / Cloudbeds

**Mews Operations API**: exposes `enterprises`, `services` (= bookable units), `resources` (= rooms), `resourceCategories` (= room types). Content fields минимальны: name + description + classifications + images через marketing-content endpoints.

**Cloudbeds API**: `getHotelDetails` returns address, contacts, descriptions, policies, photos. `getRoomTypes` returns: `roomTypeID, roomTypeName, roomTypeDescription, maxGuests, adultsIncluded, childrenIncluded, roomTypePhotos[], roomTypeAmenities[]`.

Pattern across all four (Apaleo/Mews/Cloudbeds/MyFidelio): **Property → RoomType → Unit**. Должны следовать canonical 3-layer.

---

## 4. Russian Standards (must для legal compliance)

### 4.1 Постановление Правительства РФ № 1951 от 27.12.2024

Заменил ПП-1860. Effective: 1 Jan 2025 → 1 Jan 2031.

**Mandatory** для всех `средств размещения`:
- Hotels, apart-hotels, sanatoria, hostels, camping, glamping, recreation bases.
- Deadline для входа в **Единый реестр**: **1 Sep 2025**.
- **Penalties с 6 Sep 2025**: officials 50-70k ₽, **legal entities 300-450k ₽**.
- "No stars" категория удалена — properties либо classified at 1*-5*, либо registered без star (camping/recreation base/etc).

**Star rating drives mandatory amenities**; **Приложение № 5** (требования к номерам) и **Приложение № 6** (балльная оценка) — canonical lists.

Highlights для RU integration:
- New emphasis на **family rooms** и **mobility-impaired (МГН)** rooms — bonus points + minimum quotas (4*/5* с 50+ rooms must have ≥5% multi-room/connecting и ≥5% high-category rooms).
- Multi-occupancy rooms capped at **8 persons** (был 12).
- **Категории номеров:** 5 высших + 5 стандартных = 10 categories (junior_suite, suite, apartment, studio, family, accessible, standard_1room, standard_2room, ...).
- Для Sochi (курортная категория): seasonal classification, anti-seismic requirements, tour operator registration. Sochi-specific: туристический налог 2% от 2026.

**Schema impact:**
```ts
classification {
  category: 1 | 2 | 3 | 4 | 5 | null  // 1-5 stars или null
  certificateNumber: string
  validUntil: date
  registryEntryNumber: string  // Реестр КСР
}
roomCategory: enum
  ('junior_suite' | 'suite' | 'apartment' | 'studio' |
   'family' | 'accessible' | 'standard_1room' | 'standard_2room' | ...)
accessibility {
  mobilityImpaired: bool
  hearingImpaired: bool
}
area_m2: number  // обязательное per ПП-1951
```

### 4.2 ГОСТ Р 51185-2014 — ОТМЕНЁН

**Cancelled 23 Dec 2019 by Rosstandart** — no longer operative. ПП-1951 supersedes. Не reference в новой schema.

### 4.3 Информационное сопровождение (152-ФЗ + ЗоЗПП)

Property page must display:
- Full legal name, ОГРН, адрес, contact info.
- Услуги/цены, правила проживания.
- Информация о классификации (категория + номер сертификата).
- Миграционный учёт.
- Политика обработки ПД.

---

## 5. Photos & Media Management — Canonical 2026

### 5.1 Source dimensions

| Channel/Use | Min | Recommended | Aspect |
|---|---|---|---|
| Booking.com | 2048×1080 | 4000×3000 (~12MP) | landscape, free-form |
| Booking.com 360° | 1280×900 | 4000×2000 | exactly 2:1 |
| Expedia | 1024×768 | 2880×1920 | 3:2 preferred |
| Airbnb | 1024×683 | 2048×1365 | 3:2 |
| Google Hotels (Maps) | 720p | 1920×1080 | 16:9 |
| Our widget hero | — | 1920×1280 | 3:2 |

**Canonical store dimension: 4000×3000 original** (или 4032×3024 от modern phones). OTA-distributable master. Always store original; everything else derived.

### 5.2 Variants (pre-rendered + on-the-fly fallback)

Pre-render at upload time:

| Variant | Width | Format | Use |
|---|---|---|---|
| `thumb` | 320 | AVIF + WebP | search-result card thumbnail |
| `card` | 800 | AVIF + WebP | property card hero |
| `medium` | 1280 | AVIF + WebP | room gallery card |
| `large` | 1920 | AVIF + WebP | hero / lightbox |
| `xl` | 2880 | AVIF + WebP | retina lightbox |
| `original` | source | original (JPEG/HEIC→JPEG) | OTA distribution + downloads |

`<picture>` с `srcset` + `sizes`. **AVIF gives 20-30% LCP win** над WebP-only на image-heavy pages — но keep WebP fallback для Safari < 16. Add `width`/`height` атрибуты для CLS prevention.

### 5.3 Yandex Cloud media pipeline

**Yandex Cloud НЕ предлагает** managed image-transformation как Cloudinary/Imgix на 2026.

**Canonical pattern:**
1. **Upload** → original в Object Storage `media-original/` (versioned, encrypted, private).
2. **Cloud Function** trigger на `s3:ObjectCreated:*` → reads original, runs **`sharp` (Node.js)** или vips/imagemagick, генерирует 6 variants × 2 formats = 12 files, writes в `media-derived/`.
3. **Yandex Cloud CDN** в front of `media-derived/` для global edge caching (Sochi → Moscow → Krasnodar PoPs).
4. **Smart 404 fallback**: routing rule на Cloud Function для on-demand generation новых variants.
5. **Signed URLs** для non-public assets (interior staff-only photos).

**EXIF strip mandatory** на step 2 (privacy: GPS, device) — `sharp.withMetadata({ exif: {} })`.

### 5.4 a11y (axe gate)

- Каждое image record имеет required `alt_ru` (RU) и optional `alt_en`.
- Decorative images — `alt=""` explicitly.
- Captions separate от alt.
- Carousel/lightbox — keyboard navigation + focus trap.

### 5.5 Video tours / 360°

- **Video**: original MP4 (H.264 baseline + AAC) до 100MB; transcode to HLS (240p/480p/720p/1080p).
- **360°**: equirectangular JPEG 4000×2000 minimum, 2:1 aspect. Embed via Marzipano или Pannellum (open-source).

---

## 6. Property Description Structure

Canonical fields:

```ts
{
  shortDescription: { ru: string, en?: string },  // 160 chars max (SERP meta)
  longDescription: { ru: string, en?: string },   // markdown body
  sections: {
    location: I18nText,      // район, transport, walk distance
    services: I18nText,      // restaurant, spa, pool
    rooms: I18nText,         // overall feel
    dining: I18nText,        // restaurants & bars
    activities: I18nText,    // tennis, ski, golf
    family: I18nText,        // kids amenities
    accessibility: I18nText, // МГН-rooms, ramps, lift
    pets: I18nText,
  },
  tagline: I18nText,
  seo: {
    metaTitle: I18nText,        // <70 chars
    metaDescription: I18nText,  // <160 chars
    h1: I18nText,
    structuredData: 'auto',     // JSON-LD Hotel/LodgingBusiness
  }
}
```

i18n: **RU mandatory, EN strongly recommended** для Sochi (international tourism: Iran, Turkey, India, China inbound).

Storage: `Map<locale, string>`.

**Markdown для body**, plain text для short fields. **Не WYSIWYG** — markdown portable to OTA channels and mobile.

**Schema.org JSON-LD** auto-emit `Hotel` (или `LodgingBusiness`) с `name, description, image[], address (PostalAddress), geo (GeoCoordinates), starRating, amenityFeature[] (LocationFeatureSpecification), checkinTime, checkoutTime, telephone, email, sameAs[]`. AI assistants читают для property visibility 2026.

---

## 7. Location Data

Store **structured + freeform**:

```ts
{
  address: {
    countryCode: 'RU',
    region: 'Краснодарский край',
    locality: 'Сочи',
    district: 'Адлерский',
    street: 'ул. Орджоникидзе',
    house: '11',
    postalCode: '354340',
    raw: 'Россия, Краснодарский край, г. Сочи, ул. Орджоникидзе, 11, 354340',
  },
  geo: { lat: 43.5855, lng: 39.7231 },  // WGS84
  distances: {
    sochi_airport_aer: 28.4,   // км
    krasnaya_polyana: 39.7,
    rosa_khutor: 47.0,
    sochi_railway: 1.8,
    beach_nearest: 0.3,
    olimpiyskiy_park: 24.0,
  },
  directions: I18nText,
  yandexMapEmbed: { placemarkLabel: I18nText, zoom: 15 },
}
```

Use **Yandex Maps JS API v3** для embedded interactive map; HTTP **Геокодер API** для forward/reverse geocoding at admin-time; **Yandex Maps Map Widget** (iframe) как no-script fallback.

Distance to POIs precomputed at save-time (admin вводит address → background job geocodes + computes haversine to fixed catalog Sochi POIs).

---

## 8. Room Types (UnitGroup)

```ts
{
  code: 'DLX_SEA',
  name: I18nText,                  // "Делюкс с видом на море"
  description: I18nText,
  category: 'standard_2room',      // ПП-1951 enum
  size_m2: 32,
  maxOccupancy: { adults: 2, children: 2, infants: 1, total: 4 },
  beds: [{ type: 'king', count: 1 }, { type: 'sofa_bed', count: 1 }],
  view: ['sea_view', 'mountain_view'],
  floorPolicy: 'high_floor_on_request',
  smokingPolicy: 'non_smoking',
  amenities: [/* AMN_AC, AMN_BALCONY, AMN_JACUZZI, AMN_KITCHENETTE */],
  accessibility: { mobilityImpaired: false, hearingImpaired: false },
  photos: MediaRef[],
  countInProperty: 8,              // physical units
}
```

`view` — enum array (NOT free text), maps to RMA codes 223/224/5109/5110/5121/5122 при distribution.

`beds` — enables max-occupancy validation против rate plan child rules.

---

## 9. Контакты

```ts
{
  primary: { phone: '+7 862 555 1234', formatted: '+7 (862) 555-12-34' },
  whatsapp: '+78625551234',
  telegram: '@grandhotel_sochi',     // critical RU channel
  email: 'reception@example.ru',
  emailBookings: 'booking@example.ru',
  web: 'https://example.ru',
  socialMedia: {
    vk: 'https://vk.com/...',
    ok: 'https://ok.ru/...',
    tg_channel: 'https://t.me/...',
    instagram: 'https://instagram.com/...',  // blocked в RU но useful international
  },
  hours: {
    reception: '24/7',
    checkIn: '14:00',
    checkOut: '12:00',
  }
}
```

**Telegram + WhatsApp Business** — must для RU market — guests предпочитают chat phone.

Separate `emailBookings` для conversion attribution.

---

## 10. Cancellation Policy (как часть property content)

Cancellation policy lives на rate plan уровне (per Booking.com/Apaleo/Mews convention) но property-level "default policy" может быть displayed на property card:

```ts
{
  ratePlanId,
  type: 'free_cancellation' | 'non_refundable' | 'partial_refund',  // ⚠️ "non_refundable" в РФ нельзя enforce per ПП №1912 — см. cancellation research
  freeCancellationUntil: {
    relative: { hoursBeforeCheckIn: 48 },
    // resolved per-booking → ISO date string в widget
  },
  penalties: [
    { fromHours: 48, toHours: 24, amount: { type: 'first_night' } },
    { fromHours: 24, toHours: 0,  amount: { type: 'full_stay' } },  // ⚠️ РФ-2026 cap = 1 night
  ],
  noShowPenalty: { type: 'first_night' },  // 1 night cap РФ
  displayText: I18nText,
}
```

Widget rendering canon: **always show explicit cutoff date/time** ("Бесплатная отмена до 23 мая 2026, 14:00"), not relative ("за 48ч").

---

## Confidence levels

- **High**: OTA schema, Booking.com HAC/RMA/ITT codes, Booking.com photo requirements, Apaleo unit-group pattern, ПП-1951 effective dates, Yandex Maps API surface.
- **Medium-high**: Apaleo Content API photo upload (Swagger access blocked, community), Expedia EQC enumerations (full code dictionary requires partner login), full ПП-1951 Приложение № 5 area minimums.
- **Medium**: HTNG codelist coverage (defers to OTA), Mews/Cloudbeds full content schemas (need partner accounts).

---

## Open questions

1. **Apaleo Content REST API** для photos — public POST endpoint для unit-group images, или UI-only?
2. **Booking.com 2026 REST replacements** для OTA_HotelDescriptiveContentNotif — exact field structure for amenities + photos partner-portal gated.
3. **ПП-1951 Приложение № 5** numeric area minimums per category — нужно reading 100+ page annex.
4. **Yandex Smart Images** — managed image-transformation сервис в late 2025/early 2026? Search returned nothing; current canon — self-managed Object Storage + Cloud Functions.
5. **WhatsApp Business API в RU** post-2026 — sanctions impact на official WABA access. Telegram safer canonical.
6. **Реестр объектов классификации** — Минэкономразвития публикует API для property/category lookup?

---

## Sources

**OTA / OpenTravel:**
- [OTA_HotelDescriptiveContentNotifRQ XSD (GitHub)](https://github.com/ExM/XsdCoverage/blob/master/Ota/XsdShemas/OTA_HotelDescriptiveContentNotifRQ.xsd)
- [OpenTravel Specs Download](https://opentravel.org/download-specs/)

**Booking.com:**
- [HAC Codes (OTA 2014B)](https://developers.booking.com/connectivity/docs/codes-hac)
- [RMA Codes](https://developers.booking.com/connectivity/docs/codes-rma)
- [ITT Image Tag Codes](https://developers.booking.com/connectivity/docs/codes-itt)
- [Connectivity Amenities API](https://developers.booking.com/connectivity/docs/api-reference/amenities)
- [Photo Requirements](https://partner.booking.com/en-us/help/property-page/photos-extranet/understanding-photo-requirements-your-property)

**Expedia:**
- [Amenity Resources](https://developers.expediagroup.com/supply/lodging/docs/property_mgmt_apis/product/reference/amenity_resources/)

**Apaleo / Mews / Cloudbeds:**
- [Apaleo Developer Documentation](https://apaleo.dev/)
- [Apaleo API Endpoints](https://apaleo.dev/guides/api/endpoints.html)
- [Apaleo Translations Discussion](https://github.com/apaleo/api/discussions/966)
- [Mews Open API](https://docs.mews.com/)
- [Cloudbeds API Docs](https://hotels.cloudbeds.com/api/v1.1/docs/)

**РФ:**
- [ПП РФ № 1951 от 27.12.2024 (КонсультантПлюс)](https://www.consultant.ru/document/cons_doc_LAW_495340/)
- [ПП РФ № 1951 (ГАРАНТ)](https://www.garant.ru/hotlaw/federal/1778726/)
- [ГОСТ Р 51185-2014 (отменён 2019)](https://internet-law.ru/gosts/gost/58791)
- [Travelline: классификация 2025](https://www.travelline.ru/blog/klassifikatsii-gostinits-polozhenie-i-izmeneniya-s-1-yanvarya-2025-goda/)

**Yandex Cloud:**
- [Yandex Object Storage S3 docs](https://yandex.cloud/en/docs/storage/s3/)
- [On-the-fly thumbnails (Matrosov)](https://nikolaymatrosov.medium.com/yandex-cloud-on-the-fly-thumbnails-46963af33e02)
- [Yandex Maps JavaScript API](https://yandex.ru/maps-api/products/js-api)

**Standards:**
- [Schema.org Hotel](https://schema.org/Hotel)
- [Schema.org LodgingBusiness](https://schema.org/docs/hotels.html)
- [Hotel Schema Markup Guide 2026](https://getwaymarker.com/blog/hotel-schema-markup-complete-guide/)
- [Responsive Images Cheatsheet 2026](https://www.imagetourl.cloud/guides/responsive-images-cheatsheet/)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
