/**
 * Demo tenant seeder — creates / restores demo tenant с mode='demo'.
 *
 * Per `project_demo_strategy.md` (always-on demo product surface 2026-04-28):
 *   - Demo tenants get Mock adapters навсегда (epgu/rkl/vision/payment/archive)
 *   - Cron periodically restores «golden state»
 *   - Production tenants flip mode='production' для Live adapters (M8.B)
 *
 * Run: `pnpm seed:demo` (один раз перед deploy OR через demo-refresh cron).
 *
 * **Scope (MVP)** — proves wiring + flip switch:
 *   - 1 organization (BetterAuth row) с slug='demo-sirius'
 *   - 1 organizationProfile с mode='demo' + ЕПГУ canonical config
 *
 * **Deferred к M9+ (sync с deploy)**:
 *   - Property + roomTypes + rooms + ratePlan + 14-day rates/availability
 *   - 3+ guests с realistic Russian/Kazakh/Uzbek паспорт data
 *   - 5+ bookings spanning past/future window mixed states
 *   - guestDocuments + migrationRegistrations в разных EPGU statuses
 *
 * Why MVP-only сейчас: full domain seed требует exact schema alignment
 * для всех 19+ tables. Production deploy = exact moment где golden data
 * matters; до того момента foundation enough для verifying mode='demo'
 * gates work end-to-end. Full seeder expanded в M9 booking-widget commit.
 *
 * Idempotent: deterministic IDs → safe re-run. Cron periodically refreshes.
 */

import { newId } from '@horeca/shared'
import { createAvailabilityFactory } from '../domains/availability/availability.factory.ts'
import { createBookingFactory } from '../domains/booking/booking.factory.ts'
import { createPropertyFactory } from '../domains/property/property.factory.ts'
import { createRateFactory } from '../domains/rate/rate.factory.ts'
import { createRatePlanFactory } from '../domains/ratePlan/ratePlan.factory.ts'
import { createRoomFactory } from '../domains/room/room.factory.ts'
import { createRoomTypeFactory } from '../domains/roomType/roomType.factory.ts'
import { InvalidBookingTransitionError, NoInventoryError } from '../errors/domain.ts'
import { frozenTimeProvider } from '../lib/time-provider.ts'
import { sql } from './index.ts'
import { assertSeedState } from './verify-seed.ts'
import { demoPropertyIdForOrg } from '../lib/demo-channel-seed.ts'
import { seedDemoReviewsCore } from '../domains/review/review.demo-seed.ts'
import { createReviewRepo } from '../domains/review/review.repo.ts'
import { dateFromIso, NULL_INT32, NULL_TEXT, NULL_TIMESTAMP, toJson, toTs } from './ydb-helpers.ts'

const TENANT_ID = 'demo-sochi-sirius'
const SLUG = 'demo-sirius'

// M9.widget.1 — MVP property + roomTypes для public widget endpoint.
// Полный polish (5-7 rooms + photos + 14d availability + reviews + JSON-LD)
// — М9.widget.8 demo polish sub-phase.
//
// Round 14.6.4 follow-up — derive via canonical `demoPropertyIdForOrg`
// helper (single source of truth для per-tenant demo property shape).
// Pre-fix this was a 4th hardcoded `'demo-prop-sirius-main'` literal I
// missed in the propertyId sweep (commit 85c5bf8) — caught by adversarial
// self-review per `feedback_self_review_finds_halfmeasure`. Grepping the
// codebase confirmed zero external references к the old literal value.
const DEMO_PROPERTY_ID = demoPropertyIdForOrg(TENANT_ID)
const DEMO_ROOM_TYPE_DELUXE_ID = 'demo-roomtype-deluxe'
const DEMO_ROOM_TYPE_STANDARD_ID = 'demo-roomtype-standard'

export async function runSeedDemoTenant(): Promise<{ tenantId: string }> {
	console.log(`🌱 Seeding demo tenant: ${TENANT_ID}`)
	const now = new Date()
	const nowTs = toTs(now)

	console.log('  → Step 1/4: organization (BetterAuth row)')
	await sql`
		UPSERT INTO organization (id, name, slug, createdAt)
		VALUES (${TENANT_ID}, ${'Гостиница Сириус (демо)'}, ${SLUG}, ${now})
	`

	console.log('  → Step 2/4: organizationProfile с mode=demo + ЕПГУ config')
	// Sprint C+ Round 6 Legal P0 fix 2026-05-24 — ksrRegistryId hard-gate.
	// Demo subdomain MUST have a valid-shaped ksrRegistryId (Cyrillic С + 12
	// digits per ПП-1951) чтобы booking.create не throw'ил 428. Dummy demo-
	// only value `С000000000001` — НЕ настоящий реестровый номер; demo banner
	// уже warns users «не загружайте реальные данные». Production tenants
	// onboard через UI с реальным номером из tourism.fsa.gov.ru.
	await sql`
		UPSERT INTO organizationProfile (
			\`organizationId\`, \`plan\`, \`createdAt\`, \`updatedAt\`, \`mode\`,
			\`epguDefaultChannel\`, \`epguSupplierGid\`, \`epguRegionCodeFias\`,
			\`ksrRegistryId\`
		) VALUES (
			${TENANT_ID}, ${'free'}, ${nowTs}, ${nowTs}, ${'demo'},
			${'gost-tls'}, ${'demo-supplier-gid'}, ${'demo-fias-sochi'},
			${'С000000000001'}
		)
	`

	// M9.widget.1 — minimal property с isPublic=true для widget endpoint.
	// M9.widget.6 / А4 — `publicEmbedDomains` для embed widget allowlist.
	// Demo origins: localhost ports for dev tenant page testing + sample
	// "hotel-sirius.demo" public origin (production deploy adds real
	// tenant origins via admin UI carry-forward в M11).
	console.log('  → Step 3/4: property (public, active, Сочи tourism tax 2%, embed allowlist)')
	// HTTPS only — D24 canon enforced via `embed.repo` zod schema. For local
	// empirical curl testing we hit the route directly (no Origin verification
	// on bundle GET path itself; CORS reflection is opt-in).
	const demoEmbedAllowlist = ['https://hotel-sirius.demo', 'https://www.hotel-sirius.demo']
	await sql`
		UPSERT INTO property (
			\`tenantId\`, \`id\`, \`name\`, \`address\`, \`city\`, \`timezone\`,
			\`tourismTaxRateBps\`, \`isActive\`, \`isPublic\`,
			\`publicEmbedDomains\`,
			\`createdAt\`, \`updatedAt\`
		) VALUES (
			${TENANT_ID}, ${DEMO_PROPERTY_ID},
			${'Гостиница Сириус — Морская резиденция'},
			${'Сириус, Олимпийский проспект 21'},
			${'Сириус'},
			${'Europe/Moscow'},
			${200},
			${true}, ${true},
			${toJson(demoEmbedAllowlist)},
			${nowTs}, ${nowTs}
		)
	`

	console.log('  → Step 4/4: 2 roomTypes (Deluxe Sea View + Standard Mountain)')
	await sql`
		UPSERT INTO roomType (
			\`tenantId\`, \`id\`, \`propertyId\`, \`name\`, \`description\`,
			\`maxOccupancy\`, \`baseBeds\`, \`extraBeds\`, \`areaSqm\`,
			\`inventoryCount\`, \`isActive\`, \`createdAt\`, \`updatedAt\`
		) VALUES (
			${TENANT_ID}, ${DEMO_ROOM_TYPE_DELUXE_ID}, ${DEMO_PROPERTY_ID},
			${'Deluxe Sea View'},
			${'25 м², 2 гостя, балкон с видом на море. Завтрак включён.'},
			${2}, ${1}, ${0}, ${25},
			${8}, ${true}, ${nowTs}, ${nowTs}
		)
	`
	await sql`
		UPSERT INTO roomType (
			\`tenantId\`, \`id\`, \`propertyId\`, \`name\`, \`description\`,
			\`maxOccupancy\`, \`baseBeds\`, \`extraBeds\`, \`areaSqm\`,
			\`inventoryCount\`, \`isActive\`, \`createdAt\`, \`updatedAt\`
		) VALUES (
			${TENANT_ID}, ${DEMO_ROOM_TYPE_STANDARD_ID}, ${DEMO_PROPERTY_ID},
			${'Standard Mountain View'},
			${'18 м², 2 гостя, вид на горы Красной Поляны.'},
			${2}, ${1}, ${1}, ${18},
			${16}, ${true}, ${nowTs}, ${nowTs}
		)
	`

	// M9.widget.2 — ratePlans (BAR Flex + BAR NR per roomType) + rates + availability.
	console.log('  → Step 5/7: ratePlans (4 = 2 plans × 2 roomTypes)')
	const ratePlans: Array<{
		id: string
		roomTypeId: string
		name: string
		code: string
		isDefault: boolean
		isRefundable: boolean
		cancelHours: number | null
		nightlyMicros: bigint
	}> = [
		{
			id: 'demo-rateplan-deluxe-bar-flex',
			roomTypeId: DEMO_ROOM_TYPE_DELUXE_ID,
			name: 'Гибкий тариф',
			code: 'BAR_FLEX',
			isDefault: true,
			isRefundable: true,
			cancelHours: 24,
			nightlyMicros: 8_000_000_000n, // 8000 RUB
		},
		{
			id: 'demo-rateplan-deluxe-bar-nr',
			roomTypeId: DEMO_ROOM_TYPE_DELUXE_ID,
			name: 'Невозвратный тариф',
			code: 'BAR_NR',
			isDefault: false,
			isRefundable: false,
			cancelHours: null,
			nightlyMicros: 7_200_000_000n, // 7200 RUB
		},
		{
			id: 'demo-rateplan-standard-bar-flex',
			roomTypeId: DEMO_ROOM_TYPE_STANDARD_ID,
			name: 'Гибкий тариф',
			code: 'BAR_FLEX',
			isDefault: true,
			isRefundable: true,
			cancelHours: 24,
			nightlyMicros: 5_000_000_000n, // 5000 RUB
		},
		{
			id: 'demo-rateplan-standard-bar-nr',
			roomTypeId: DEMO_ROOM_TYPE_STANDARD_ID,
			name: 'Невозвратный тариф',
			code: 'BAR_NR',
			isDefault: false,
			isRefundable: false,
			cancelHours: null,
			nightlyMicros: 4_500_000_000n, // 4500 RUB
		},
	]

	for (const rp of ratePlans) {
		await sql`
			UPSERT INTO ratePlan (
				\`tenantId\`, \`id\`, \`propertyId\`, \`roomTypeId\`, \`name\`, \`code\`,
				\`isDefault\`, \`isRefundable\`, \`cancellationHours\`, \`mealsIncluded\`,
				\`minStay\`, \`maxStay\`, \`isActive\`, \`currency\`,
				\`createdAt\`, \`updatedAt\`
			) VALUES (
				${TENANT_ID}, ${rp.id}, ${DEMO_PROPERTY_ID}, ${rp.roomTypeId},
				${rp.name}, ${rp.code}, ${rp.isDefault}, ${rp.isRefundable},
				${rp.cancelHours === null ? NULL_INT32 : rp.cancelHours},
				${rp.code === 'BAR_FLEX' ? 'breakfast' : 'none'},
				${1}, ${30}, ${true}, ${'RUB'},
				${nowTs}, ${nowTs}
			)
		`
	}

	console.log('  → Step 6/7: 120-day availability calendar (2 roomTypes × 120 days = 240 rows)')
	const today = new Date()
	today.setUTCHours(0, 0, 0, 0)
	const dates: string[] = []
	// Past 60 days + future 60 days = 120 days total. Past range required
	// since BOOKING_PLAN contains historical seed bookings (checked_out
	// dayOffset=-45, no_show -14, etc.) — per canonical refactor 2026-05-18,
	// each booking goes через `bookingService.create()` which reads
	// availability + rate rows for each night. Без past dates, repo throws
	// NoInventoryError для historical bookings (correct domain behavior —
	// real API would require availability seed first). 60 days covers
	// max-past spec в BOOKING_PLAN с margin.
	const PAST_DAYS = 60
	for (let i = -PAST_DAYS; i < 60; i++) {
		const d = new Date(today.getTime() + i * 86_400_000)
		dates.push(
			`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
				d.getUTCDate(),
			).padStart(2, '0')}`,
		)
	}

	for (const roomTypeId of [DEMO_ROOM_TYPE_DELUXE_ID, DEMO_ROOM_TYPE_STANDARD_ID]) {
		const inventory = roomTypeId === DEMO_ROOM_TYPE_DELUXE_ID ? 5 : 10
		for (const dateIso of dates) {
			// Canon 2026-05-18: initial `sold=0`. Booking service (called в Step 9)
			// атomically increments per-night sold + writes occupancy + slot rows
			// via canonical repo path. Pre-refactor pseudo-sold pattern broke
			// behaviour-faithful contract (demo state не reachable через real API).
			const sold = 0
			await sql`
				UPSERT INTO availability (
					\`tenantId\`, \`propertyId\`, \`roomTypeId\`, \`date\`,
					\`allotment\`, \`sold\`, \`minStay\`, \`maxStay\`,
					\`closedToArrival\`, \`closedToDeparture\`, \`stopSell\`,
					\`createdAt\`, \`updatedAt\`
				) VALUES (
					${TENANT_ID}, ${DEMO_PROPERTY_ID}, ${roomTypeId}, ${dateFromIso(dateIso)},
					${inventory}, ${sold}, ${NULL_INT32}, ${NULL_INT32},
					${false}, ${false}, ${false},
					${nowTs}, ${nowTs}
				)
			`
		}
	}

	console.log('  → Step 7/7: 120-day rates (4 ratePlans × 120 days = 480 rows)')
	for (const rp of ratePlans) {
		for (const dateIso of dates) {
			// Weekend uplift +20% (Сочи canon: пятница/суббота).
			const dow = new Date(`${dateIso}T00:00:00Z`).getUTCDay()
			const weekend = dow === 5 || dow === 6
			const amt = weekend
				? (rp.nightlyMicros * 12n) / 10n // +20%
				: rp.nightlyMicros
			await sql`
				UPSERT INTO rate (
					\`tenantId\`, \`propertyId\`, \`roomTypeId\`, \`ratePlanId\`, \`date\`,
					\`amountMicros\`, \`currency\`,
					\`createdAt\`, \`updatedAt\`
				) VALUES (
					${TENANT_ID}, ${DEMO_PROPERTY_ID}, ${rp.roomTypeId}, ${rp.id}, ${dateFromIso(dateIso)},
					${amt}, ${'RUB'},
					${nowTs}, ${nowTs}
				)
			`
		}
	}

	console.log('  → M9.widget.3: 5 Сочи addons (extras / addons screen)')
	// Per `plans/m9_widget_canonical.md` §3 + Round 2 verified compliance:
	// - All addons isActive=true, isMandatory=false (opt-in, ЗоЗПП ст. 16 ч. 3.1).
	// - vatBps=2200 (НДС 22% per 425-ФЗ от 28.11.2025) для a-la-carte addons.
	//   Spa-без-медлицензии = 22% (демо тенант не имеет лицензии).
	// - inventoryMode='NONE' для всех 5 (TIME_SLOT deferred).
	// - Categories distributed для realistic Сочи mix:
	//   FOOD_AND_BEVERAGES (breakfast), PARKING, LATE_CHECK_OUT, TRANSFER, WELLNESS (spa).
	// - Childcare cot — namely free amenity «по запросу», НЕ paid addon (152-ФЗ:
	//   избегаем сбор baby-DOB как special-category PII).
	const DEMO_ADDONS: Array<{
		id: string
		code: string
		category: string
		nameRu: string
		nameEn: string | null
		descRu: string
		pricingUnit: string
		priceMicros: bigint
		sortOrder: number
	}> = [
		{
			id: 'demo-addon-breakfast',
			code: 'BREAKFAST',
			category: 'FOOD_AND_BEVERAGES',
			nameRu: 'Завтрак-буфет',
			nameEn: 'Breakfast buffet',
			descRu: 'Шведский стол: блюда русской и европейской кухни, морепродукты Чёрного моря.',
			pricingUnit: 'PER_NIGHT_PER_PERSON',
			priceMicros: 1_500_000_000n, // 1500 ₽
			sortOrder: 10,
		},
		{
			id: 'demo-addon-parking',
			code: 'PARKING',
			category: 'PARKING',
			nameRu: 'Охраняемая парковка',
			nameEn: 'Secured parking',
			descRu: 'Огороженная территория с круглосуточным видеонаблюдением, 1 место за номер.',
			pricingUnit: 'PER_NIGHT',
			priceMicros: 500_000_000n, // 500 ₽
			sortOrder: 20,
		},
		{
			id: 'demo-addon-late-checkout',
			code: 'LATE_CHECKOUT',
			category: 'LATE_CHECK_OUT',
			nameRu: 'Поздний выезд (до 18:00)',
			nameEn: 'Late check-out (until 18:00)',
			descRu: 'Дополнительные 6 часов в номере без переезда. Подтверждается за 24 часа до отъезда.',
			pricingUnit: 'PER_STAY',
			priceMicros: 1_500_000_000n, // 1500 ₽
			sortOrder: 30,
		},
		{
			id: 'demo-addon-transfer',
			code: 'TRANSFER_AER',
			category: 'TRANSFER',
			nameRu: 'Трансфер аэропорт Сочи (Адлер) ⇄ отель',
			nameEn: 'Sochi airport (Adler) ⇄ hotel transfer',
			descRu: 'Комфортный седан или минивэн (3-7 мест), встреча с табличкой, 30 мин в пути.',
			pricingUnit: 'PER_STAY',
			priceMicros: 2_500_000_000n, // 2500 ₽
			sortOrder: 40,
		},
		{
			id: 'demo-addon-spa',
			code: 'SPA_HOUR',
			category: 'WELLNESS',
			nameRu: 'СПА-комплекс',
			nameEn: 'Spa complex',
			descRu: 'Бассейн, сауна, хаммам. Стоимость почасовая, без медицинских процедур (НДС 22%).',
			pricingUnit: 'PER_HOUR',
			priceMicros: 3_000_000_000n, // 3000 ₽
			sortOrder: 50,
		},
	]
	for (const a of DEMO_ADDONS) {
		await sql`
			UPSERT INTO propertyAddon (
				\`tenantId\`, \`propertyId\`, \`addonId\`,
				\`code\`, \`category\`,
				\`nameRu\`, \`nameEn\`, \`descriptionRu\`, \`descriptionEn\`,
				\`pricingUnit\`, \`priceMicros\`, \`currency\`, \`vatBps\`,
				\`isActive\`, \`isMandatory\`,
				\`inventoryMode\`,
				\`seasonalTagsJson\`, \`sortOrder\`,
				\`createdAt\`, \`createdBy\`, \`updatedAt\`, \`updatedBy\`
			) VALUES (
				${TENANT_ID}, ${DEMO_PROPERTY_ID}, ${a.id},
				${a.code}, ${a.category},
				${a.nameRu}, ${a.nameEn}, ${a.descRu}, ${NULL_TEXT},
				${a.pricingUnit}, ${a.priceMicros}, ${'RUB'}, ${2200},
				${true}, ${false},
				${'NONE'},
				${'[]'}, ${a.sortOrder},
				${nowTs}, ${'system'}, ${nowTs}, ${'system'}
			)
		`
	}

	// M9.widget.8 / A6.1 — 5 propertyMedia photo rows (Picsum.photos URLs as demo placeholders).
	// Real S3-CDN photos carry-forward к Track B operator onboarding. originalKey holds
	// either an S3 key OR a full https URL — read-side resolves accordingly.
	console.log('  → Step 8/10: 5 propertyMedia photos (Picsum.photos demo placeholders)')
	const DEMO_PHOTOS: ReadonlyArray<{
		mediaId: string
		seed: string
		altRu: string
		isHero: boolean
		sortOrder: number
	}> = [
		{
			mediaId: 'demo-photo-facade',
			seed: 'sirius-facade',
			altRu: 'Фасад гостиницы',
			isHero: true,
			sortOrder: 10,
		},
		{
			mediaId: 'demo-photo-lobby',
			seed: 'sirius-lobby',
			altRu: 'Лобби',
			isHero: false,
			sortOrder: 20,
		},
		{
			mediaId: 'demo-photo-deluxe',
			seed: 'sirius-deluxe',
			altRu: 'Номер Deluxe Sea View',
			isHero: false,
			sortOrder: 30,
		},
		{
			mediaId: 'demo-photo-standard',
			seed: 'sirius-standard',
			altRu: 'Номер Standard Mountain View',
			isHero: false,
			sortOrder: 40,
		},
		{
			mediaId: 'demo-photo-restaurant',
			seed: 'sirius-restaurant',
			altRu: 'Ресторан',
			isHero: false,
			sortOrder: 50,
		},
	]
	for (const ph of DEMO_PHOTOS) {
		await sql`
			UPSERT INTO propertyMedia (
				\`tenantId\`, \`propertyId\`, \`mediaId\`, \`roomTypeId\`, \`kind\`,
				\`originalKey\`, \`mimeType\`, \`widthPx\`, \`heightPx\`, \`fileSizeBytes\`,
				\`exifStripped\`, \`derivedReady\`,
				\`sortOrder\`, \`isHero\`,
				\`altRu\`, \`altEn\`, \`captionRu\`, \`captionEn\`,
				\`createdAt\`, \`createdBy\`, \`updatedAt\`, \`updatedBy\`
			) VALUES (
				${TENANT_ID}, ${DEMO_PROPERTY_ID}, ${ph.mediaId}, ${NULL_TEXT}, ${'photo'},
				${`https://picsum.photos/seed/${ph.seed}/1200/800`},
				${'image/jpeg'}, ${1200}, ${800}, ${250_000n},
				${true}, ${true},
				${ph.sortOrder}, ${ph.isHero},
				${ph.altRu}, ${NULL_TEXT}, ${NULL_TEXT}, ${NULL_TEXT},
				${nowTs}, ${'system:demo-seed'}, ${nowTs}, ${'system:demo-seed'}
			)
		`
	}

	// M9.widget.8 / A6.1 — 30 bookings (deterministic distribution across past/present/future).
	// Status distribution: 8 checked_out + 5 in_house + 12 confirmed + 3 cancelled + 2 no_show.
	// All linked to 30 deterministic guests (ИИ-generated Russian names via fixed lookup).
	console.log('  → Step 9/10: 30 guests + 30 bookings (varied statuses + dates)')

	// Pre-cleanup (canon refactor 2026-05-18): wholesale tenant-scoped DELETE.
	// Previously `LIKE 'demo-booking-%'` pattern — но canonical refactor switches
	// к `newId('booking')` = `book_XXX` typeid, breaking pattern match. Plus
	// each booking now triggers CDC cascade (folio, occupancy, slot, activity,
	// notification outbox, channel dispatch) → wholesale per-tenant cleanup
	// matches «golden state reset» semantics того demo refresh cron canon
	// (project_demo_strategy.md). Idempotent: re-runs produce identical state.
	await sql`DELETE FROM roomNightOccupancy WHERE tenantId = ${TENANT_ID}`
	await sql`DELETE FROM roomTypeNightSlot WHERE tenantId = ${TENANT_ID}`
	await sql`DELETE FROM folio WHERE tenantId = ${TENANT_ID}`
	await sql`DELETE FROM booking WHERE tenantId = ${TENANT_ID}`
	await sql`DELETE FROM guest WHERE tenantId = ${TENANT_ID}`
	// channelReview.create() uses newId() per row (non-idempotent) → wipe before
	// re-seed so demo refresh produces identical review inbox, not duplicates.
	await sql`DELETE FROM channelReview WHERE tenantId = ${TENANT_ID}`
	// Sprint C+ Round 5 5-expert audit re-framing 2026-05-24:
	//
	// **Passport-related tables (photoConsentLog/passportOcrAudit/guestDocument/
	// passportOcrAuditScrubLog) intentionally NOT deleted here** — native YDB TTL
	// handles retention canonically per migration 0037/0066/0067/0071:
	//   - passportOcrAudit: TTL P90D ON createdAt (90-day МВД-аудит canon)
	//   - guestDocument:    TTL P1825D ON createdAt (5y NK ст.23 первичка)
	//   - photoConsentLog:  TTL P1825D ON createdAt (5y ст.21 ч.4 audit proof)
	//   - passportOcrAuditScrubLog: TTL P1825D ON createdAt
	//
	// Initial Security expert T5 framing «orphan PII indefinitely» был partial —
	// TTL guarantees max 90d window (audit) / 5y (consent log) auto-cleanup
	// regardless of guest row deletion. Demo tenant accumulates a few mock-Vision
	// rows per 6h cycle = trivial volume, native TTL handles all of it.
	//
	// `guest` table HAS no TTL (live operator data, no auto-expiry) — hence
	// explicit DELETE here is correct для demo state refresh semantic (each 6h
	// cycle = fresh canonical golden state). Passport tables don't need explicit
	// DELETE since TTL already does this work passively.
	//
	// Canon: leverage native YC services (YDB TTL, S3 lifecycle, KMS, Lockbox,
	// Audit Trails) BEFORE writing custom cleanup cron / app-level retention logic.

	// Deterministic surname / first-name pool (fixed lookup, NO Math.random).
	// Common Russian surnames; matches realistic demo without hitting actual people.
	const SURNAMES = [
		'Иванов',
		'Петров',
		'Сидоров',
		'Кузнецов',
		'Смирнов',
		'Васильев',
		'Михайлов',
		'Новиков',
		'Фёдоров',
		'Морозов',
	]
	const FIRST_NAMES_M = ['Алексей', 'Дмитрий', 'Сергей', 'Андрей', 'Михаил']
	const FIRST_NAMES_F = ['Анна', 'Мария', 'Елена', 'Ольга', 'Татьяна']

	// Anchor «today» for deterministic booking dates (UTC-midnight today).
	const todayUtc = new Date(now)
	todayUtc.setUTCHours(0, 0, 0, 0)
	function offsetDays(days: number): Date {
		const d = new Date(todayUtc)
		d.setUTCDate(d.getUTCDate() + days)
		return d
	}

	// 30+ entries: [statusOffset], dayOffset relative to today, nightsCount,
	// roomTypeIdx (0=Deluxe, 1=Standard), ratePlanIdx (0=Flex, 1=NR).
	// G2.bis (2026-05-15): optional channelCode для TravelLine 8-color
	// differentiator dot demonstration. Defaults к 'direct' если omitted.
	const BOOKING_PLAN: ReadonlyArray<{
		status: string
		dayOffset: number
		nights: number
		roomTypeIdx: 0 | 1
		ratePlanIdx: 0 | 1
		guestCount: number
		channelCode?: string
	}> = [
		// 8 checked_out (past)
		{
			status: 'checked_out',
			dayOffset: -45,
			nights: 3,
			roomTypeIdx: 0,
			ratePlanIdx: 0,
			guestCount: 2,
		},
		{
			status: 'checked_out',
			dayOffset: -40,
			nights: 2,
			roomTypeIdx: 1,
			ratePlanIdx: 1,
			guestCount: 1,
		},
		{
			status: 'checked_out',
			dayOffset: -35,
			nights: 5,
			roomTypeIdx: 0,
			ratePlanIdx: 1,
			guestCount: 2,
		},
		{
			status: 'checked_out',
			dayOffset: -30,
			nights: 4,
			roomTypeIdx: 1,
			ratePlanIdx: 0,
			guestCount: 3,
		},
		{
			status: 'checked_out',
			dayOffset: -25,
			nights: 2,
			roomTypeIdx: 0,
			ratePlanIdx: 0,
			guestCount: 2,
		},
		{
			status: 'checked_out',
			dayOffset: -20,
			nights: 3,
			roomTypeIdx: 1,
			ratePlanIdx: 0,
			guestCount: 2,
		},
		{
			status: 'checked_out',
			dayOffset: -15,
			nights: 1,
			roomTypeIdx: 0,
			ratePlanIdx: 1,
			guestCount: 1,
		},
		{
			status: 'checked_out',
			dayOffset: -10,
			nights: 2,
			roomTypeIdx: 1,
			ratePlanIdx: 0,
			guestCount: 2,
		},
		// 5 in_house (currently staying — checkIn in past, checkOut in future)
		{ status: 'in_house', dayOffset: -1, nights: 4, roomTypeIdx: 0, ratePlanIdx: 0, guestCount: 2 },
		{ status: 'in_house', dayOffset: -2, nights: 5, roomTypeIdx: 1, ratePlanIdx: 0, guestCount: 3 },
		{ status: 'in_house', dayOffset: 0, nights: 2, roomTypeIdx: 0, ratePlanIdx: 1, guestCount: 2 },
		{ status: 'in_house', dayOffset: -3, nights: 7, roomTypeIdx: 1, ratePlanIdx: 1, guestCount: 4 },
		{ status: 'in_house', dayOffset: -1, nights: 3, roomTypeIdx: 0, ratePlanIdx: 0, guestCount: 2 },
		// G2 2026-05-15: 2 overdue (confirmed status + checkIn в прошлом — operator
		// urgency #1 «Просрочена» red band per TravelLine 8-color canon). Demo
		// должна показывать this state так potential customers видят G2 capability.
		{
			status: 'confirmed',
			dayOffset: -2,
			nights: 3,
			roomTypeIdx: 0,
			ratePlanIdx: 0,
			guestCount: 2,
			channelCode: 'yandexTravel',
		},
		{
			status: 'confirmed',
			dayOffset: -1,
			nights: 2,
			roomTypeIdx: 1,
			ratePlanIdx: 0,
			guestCount: 1,
		},
		// 12 confirmed (future) — mixed channel codes для G2.bis visual canon
		// (yandexTravel red-orange dot vs OTA yellow dot vs direct/walkIn no-dot).
		// Каждые 4 bookings rotate через major channel sources Сочи рынка.
		{
			status: 'confirmed',
			dayOffset: 5,
			nights: 3,
			roomTypeIdx: 0,
			ratePlanIdx: 0,
			guestCount: 2,
			channelCode: 'yandexTravel',
		},
		{
			status: 'confirmed',
			dayOffset: 7,
			nights: 4,
			roomTypeIdx: 1,
			ratePlanIdx: 1,
			guestCount: 2,
			channelCode: 'bookingCom',
		},
		{
			status: 'confirmed',
			dayOffset: 10,
			nights: 2,
			roomTypeIdx: 0,
			ratePlanIdx: 1,
			guestCount: 1,
			channelCode: 'ostrovok',
		},
		{
			status: 'confirmed',
			dayOffset: 12,
			nights: 5,
			roomTypeIdx: 1,
			ratePlanIdx: 0,
			guestCount: 3,
			channelCode: 'travelLine',
		},
		{
			status: 'confirmed',
			dayOffset: 14,
			nights: 3,
			roomTypeIdx: 0,
			ratePlanIdx: 0,
			guestCount: 2,
			channelCode: 'expedia',
		},
		{
			status: 'confirmed',
			dayOffset: 18,
			nights: 2,
			roomTypeIdx: 1,
			ratePlanIdx: 0,
			guestCount: 2,
			channelCode: 'bnovo',
		},
		{
			status: 'confirmed',
			dayOffset: 21,
			nights: 4,
			roomTypeIdx: 0,
			ratePlanIdx: 1,
			guestCount: 2,
		},
		{
			status: 'confirmed',
			dayOffset: 25,
			nights: 3,
			roomTypeIdx: 1,
			ratePlanIdx: 1,
			guestCount: 1,
		},
		{
			status: 'confirmed',
			dayOffset: 28,
			nights: 6,
			roomTypeIdx: 0,
			ratePlanIdx: 0,
			guestCount: 2,
		},
		{
			status: 'confirmed',
			dayOffset: 32,
			nights: 2,
			roomTypeIdx: 1,
			ratePlanIdx: 0,
			guestCount: 2,
		},
		{
			status: 'confirmed',
			dayOffset: 35,
			nights: 4,
			roomTypeIdx: 0,
			ratePlanIdx: 1,
			guestCount: 2,
		},
		{
			status: 'confirmed',
			dayOffset: 40,
			nights: 3,
			roomTypeIdx: 1,
			ratePlanIdx: 0,
			guestCount: 3,
		},
		// 3 cancelled
		{ status: 'cancelled', dayOffset: 8, nights: 3, roomTypeIdx: 0, ratePlanIdx: 0, guestCount: 2 },
		{
			status: 'cancelled',
			dayOffset: 15,
			nights: 4,
			roomTypeIdx: 1,
			ratePlanIdx: 1,
			guestCount: 1,
		},
		{
			status: 'cancelled',
			dayOffset: 22,
			nights: 2,
			roomTypeIdx: 0,
			ratePlanIdx: 1,
			guestCount: 2,
		},
		// 2 no_show (past, terminal status)
		{ status: 'no_show', dayOffset: -7, nights: 2, roomTypeIdx: 0, ratePlanIdx: 1, guestCount: 1 },
		{ status: 'no_show', dayOffset: -14, nights: 3, roomTypeIdx: 1, ratePlanIdx: 1, guestCount: 2 },
	]

	// roomTypeId / ratePlanId resolution.
	const roomTypeIds: ReadonlyArray<string> = [DEMO_ROOM_TYPE_DELUXE_ID, DEMO_ROOM_TYPE_STANDARD_ID]
	const ratePlanIds: ReadonlyArray<ReadonlyArray<string>> = [
		// roomTypeIdx 0 (Deluxe): [Flex, NR]
		['demo-rateplan-deluxe-bar-flex', 'demo-rateplan-deluxe-bar-nr'],
		// roomTypeIdx 1 (Standard): [Flex, NR]
		['demo-rateplan-standard-bar-flex', 'demo-rateplan-standard-bar-nr'],
	]
	const ratePlanNightlyMicros: ReadonlyArray<ReadonlyArray<bigint>> = [
		[8_000_000_000n, 7_200_000_000n], // Deluxe Flex/NR
		[5_000_000_000n, 4_500_000_000n], // Standard Flex/NR
	]
	void ratePlanNightlyMicros // service-driven: rate rows seeded above are source of truth

	// Canon refactor 2026-05-18: wire domain factories so seed creates bookings
	// via canonical service path (NOT raw UPSERT). Mirror app.ts DI exactly so
	// seed produces states reachable through real API. Per `[[project-north-
	// star-canonical]]` behaviour-faithful demo: demo-on-prod должен показывать
	// canonically-reachable state only — иначе клиент видит artifacts (overbook,
	// missing slot rows, drift sold counter) которые real PMS блокирует.
	const propertyFactory = createPropertyFactory(sql)
	const roomTypeFactory = createRoomTypeFactory(sql, propertyFactory.service)
	const roomFactory = createRoomFactory(sql, propertyFactory.service, roomTypeFactory.service)
	const ratePlanFactory = createRatePlanFactory(
		sql,
		propertyFactory.service,
		roomTypeFactory.service,
	)
	const rateFactory = createRateFactory(sql, ratePlanFactory.service)
	const availabilityFactory = createAvailabilityFactory(sql, roomTypeFactory.service)
	void availabilityFactory
	// Canon 2026-05-18 (Stripe Test Clocks): seed binds bookingFactory к frozen
	// clock anchored на «today UTC-midnight». Pre-injection seed used wall-clock
	// `new Date()` для confirmedAt/checkedInAt/checkedOutAt etc — bookings drifted
	// minute-to-minute even с identical input plan. Now confirmedAt deterministic
	// per booking offset, full re-run produces byte-identical state-transition ts.
	// Production code path uses default `realTimeProvider` (wall clock).
	const seedClock = frozenTimeProvider(todayUtc)
	const bookingFactory = createBookingFactory(
		sql,
		rateFactory.repo,
		propertyFactory.service,
		roomTypeFactory.service,
		ratePlanFactory.service,
		roomFactory.service,
		seedClock,
	)
	const bookingService = bookingFactory.service
	const SEED_ACTOR = newId('user') // typeid format (passes any future validation)

	let seededCount = 0
	let skippedCount = 0

	for (let i = 0; i < BOOKING_PLAN.length; i++) {
		const b = BOOKING_PLAN[i]
		if (!b) continue
		// Canonical typeid prefix `gst_<26-char-ulid>` per ID_PREFIXES canon.
		// Pre-2026-05-18 used `demo-guest-NN` literal — route param Zod regex
		// `^gst_[0-9a-hjkmnp-tv-z]{26}$` rejected → 400 on GET /guests/:id.
		// `[[id-prefixes-check-before-test]]` canon caught this same class
		// earlier для roomType. DELETE-before-UPSERT pattern (Step 9 start)
		// keeps idempotency at semantic level (always N bookings post-seed).
		const guestId = newId('guest')
		const surname = SURNAMES[i % SURNAMES.length] ?? 'Иванов'
		const isMale = i % 2 === 0
		const firstName = (isMale ? FIRST_NAMES_M : FIRST_NAMES_F)[Math.floor(i / 2) % 5] ?? 'Алексей'
		const docNumber = `${4500 + i}-${String(100000 + i).padStart(6, '0')}`

		await sql`
			UPSERT INTO guest (
				\`tenantId\`, \`id\`, \`lastName\`, \`firstName\`, \`middleName\`,
				\`birthDate\`, \`citizenship\`, \`documentType\`, \`documentSeries\`, \`documentNumber\`,
				\`documentIssuedBy\`, \`documentIssuedDate\`, \`registrationAddress\`,
				\`phone\`, \`email\`, \`notes\`,
				\`createdAt\`, \`updatedAt\`
			) VALUES (
				${TENANT_ID}, ${guestId}, ${surname}, ${firstName}, ${NULL_TEXT},
				${dateFromIso(`198${i % 10}-0${(i % 9) + 1}-1${i % 9}`)}, ${'RU'}, ${'PASSPORT_RF'},
				${docNumber.slice(0, 4)}, ${docNumber.slice(5)},
				${'УФМС России по г. Москве'}, ${dateFromIso('2015-06-15')},
				${'г. Москва, ул. Демонстрационная, 1'},
				${`+7900${String(1000000 + i).padStart(7, '0')}`},
				${`demo-guest-${i}@example.test`}, ${'demo seed'},
				${nowTs}, ${nowTs}
			)
		`

		const checkInDateObj = offsetDays(b.dayOffset)
		const checkOutDateObj = offsetDays(b.dayOffset + b.nights)
		const isoDay = (d: Date) =>
			`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
				d.getUTCDate(),
			).padStart(2, '0')}`
		const roomTypeId = roomTypeIds[b.roomTypeIdx] ?? DEMO_ROOM_TYPE_DELUXE_ID
		const ratePlanId =
			ratePlanIds[b.roomTypeIdx]?.[b.ratePlanIdx] ?? 'demo-rateplan-deluxe-bar-flex'

		// Canon refactor 2026-05-18: schema-strict guestSnapshot (no email/phone —
		// those live на `guest` table). Per `[[strict-tests]]` + Zod schema
		// `bookingGuestSnapshotSchema` в shared/booking.ts.
		const guestSnapshot = {
			firstName,
			lastName: surname,
			middleName: null,
			citizenship: 'RU',
			documentType: 'PASSPORT_RF',
			documentNumber: docNumber.slice(5),
		}

		// Step 1: create as confirmed via canonical service path. Service
		// validates property/roomType/ratePlan + reads rate rows + atomically
		// increments availability.sold + writes occupancy + slot rows + emits
		// CDC events. Same path real channel-push and operator-create take.
		const channelCode = (b.channelCode ?? 'direct') as Parameters<
			typeof bookingService.create
		>[2]['channelCode']
		try {
			const created = await bookingService.create(
				TENANT_ID,
				DEMO_PROPERTY_ID,
				{
					roomTypeId,
					ratePlanId,
					checkIn: isoDay(checkInDateObj),
					checkOut: isoDay(checkOutDateObj),
					guestsCount: b.guestCount,
					primaryGuestId: guestId,
					guestSnapshot,
					channelCode,
				},
				SEED_ACTOR,
			)

			// Step 2: transition к target status using canonical service path.
			// Each transition writes audit + CDC events identically to real flow.
			if (b.status === 'in_house') {
				await bookingService.checkIn(TENANT_ID, created.id, {}, SEED_ACTOR)
			} else if (b.status === 'checked_out') {
				await bookingService.checkIn(TENANT_ID, created.id, {}, SEED_ACTOR)
				await bookingService.checkOut(TENANT_ID, created.id, SEED_ACTOR)
			} else if (b.status === 'cancelled') {
				await bookingService.cancel(TENANT_ID, created.id, { reason: 'demo seed' }, SEED_ACTOR)
			} else if (b.status === 'no_show') {
				await bookingService.markNoShow(
					TENANT_ID,
					created.id,
					{ reason: 'demo seed: guest no-show' },
					SEED_ACTOR,
				)
			}
			seededCount += 1
		} catch (err) {
			// Canon: real channel-push would 409 NO_INVENTORY same way. Log + skip,
			// don't bypass guards. Demo состояние = strict subset of canonical state.
			if (err instanceof NoInventoryError || err instanceof InvalidBookingTransitionError) {
				console.warn(
					`  ⚠ seed booking #${i} skipped (${b.status}, ${roomTypeId}, day${b.dayOffset >= 0 ? '+' : ''}${b.dayOffset}/${b.nights}n): ${err.message}`,
				)
				skippedCount += 1
				continue
			}
			throw err
		}
	}
	console.log(
		`  → bookings seeded: ${seededCount} successful, ${skippedCount} skipped (canon-rejected: allotment/transition)`,
	)

	// M10 / A7.5.fix — channel connections для demo tenant (Боль 2.2 visible).
	// 3 channel adapters TL/YT/ETG bound к demo property. mock-mode + isEnabled=true.
	// Behaviour-faithful: same canonical interface для Mock + Sandbox + Live.
	// Live-flip = swap channelConnection.mode + populate credentialsLockboxRef.
	console.log('  → Step 7/7: M10 channel connections (3 channels TL/YT/ETG в mock mode)')
	const channelSeed: ReadonlyArray<{
		readonly channelId: 'TL' | 'YT' | 'ETG'
		readonly role: 'processor_with_dpa' | 'independent_operator'
		readonly dpaSignedAt: Date | null
	}> = [
		{ channelId: 'TL', role: 'processor_with_dpa', dpaSignedAt: now },
		{ channelId: 'YT', role: 'independent_operator', dpaSignedAt: null },
		{ channelId: 'ETG', role: 'independent_operator', dpaSignedAt: null },
	]
	for (const ch of channelSeed) {
		await sql`
			UPSERT INTO channelConnection (
				tenantId, propertyId, channelId, mode, role,
				credentialsLockboxRef, dpaSignedAt, rknOperatorId,
				crossBorderNotificationStatus, syncStatus,
				lastSyncAt, autoDisabledReason, autoDisabledAt,
				isEnabled, createdAt, updatedAt
			) VALUES (
				${TENANT_ID}, ${DEMO_PROPERTY_ID}, ${ch.channelId},
				${'mock'}, ${ch.role},
				${NULL_TEXT},
				${ch.dpaSignedAt === null ? NULL_TIMESTAMP : toTs(ch.dpaSignedAt)},
				${NULL_TEXT}, ${NULL_TEXT}, ${'idle'},
				${NULL_TIMESTAMP}, ${NULL_TEXT}, ${NULL_TIMESTAMP},
				${true}, ${nowTs}, ${nowTs}
			)
		`
	}

	// ─── Step 8/8 (2026-05-30): AI review-reply demo inbox ──────────────────
	// Реалистичные отзывы из каналов (Островок / Яндекс / Авито), статус 'new' —
	// хозяин жмёт «ИИ-ответ» (YandexGPT) → правит → «Опубликовать». ОБЩИЙ источник
	// `seedDemoReviewsCore` (тот же, что lazy per-tenant demo-провизионинг в
	// review.service.list) — single source of demo-review-набора.
	console.log('  → Step 8/8: AI review-reply seed (5 отзывов из каналов, статус new)')
	await seedDemoReviewsCore(createReviewRepo(sql), TENANT_ID, DEMO_PROPERTY_ID, now)

	console.log(`✅ Demo tenant ready: tenantId=${TENANT_ID} slug=${SLUG} mode=demo`)
	console.log(
		'   M9.widget.2 seed: 1 property + 2 roomTypes + 4 ratePlans + 120 avail + 240 rates.',
	)
	console.log('   M9.widget.3 seed: 5 Сочи addons (BREAKFAST/PARKING/LATE_CHECKOUT/TRANSFER/SPA).')
	console.log('   M9.widget.8 seed: 24 rooms (8+16) + 30 bookings + 5 photos + JSON-LD ready.')
	console.log(
		'   M10 / A7.5.fix seed: 3 channel connections (TL/YT/ETG mock-mode, isEnabled=true).',
	)
	console.log('   AI review-reply seed: 5 reviews (ostrovok/yandexTravel/avito), status=new.')

	// Post-seed invariant verification. CDC consumers project asynchronously so
	// some downstream rows (folio, slot, occupancy) materialize after a short
	// drain window. Soft-retry up to ~6s before failing — matches the empirical
	// CDC propagation budget observed (commit 5e19f60 reconciler land + Variant 3
	// strict-tests baseline 1.5-2s typical). Past this budget, surface as hard
	// failure so the seed signals «cannot reach canonical state» loudly.
	await waitForInvariants(TENANT_ID)
	return { tenantId: TENANT_ID }
}

/**
 * Wait for CDC consumers to drain (folio_creator + slot writer + reconciler),
 * then assert seed invariants pass. Polls verifySeedState() в exponential
 * backoff until all clear OR budget exhausted; final attempt uses assertSeedState
 * so violations surface как loud throws.
 *
 * Per `[[seed-canonical-no-bypass-2026-05-18]]`: bookings via service path mean
 * CDC events emit per booking lifecycle event (create + checkIn + checkOut +
 * cancel + markNoShow). All consumers must drain before we can claim canonical
 * state. 6s budget = 30 bookings × ~200ms = generous но bounded.
 */
async function waitForInvariants(tenantId: string): Promise<void> {
	const BUDGET_MS = 6_000
	const start = Date.now()
	let delayMs = 250
	const { verifySeedState } = await import('./verify-seed.ts')
	while (Date.now() - start < BUDGET_MS) {
		const violations = await verifySeedState(tenantId)
		if (violations.length === 0) {
			console.log(
				`  ✅ Seed invariants passed (post-CDC drain ${Math.round(Date.now() - start)}ms).`,
			)
			return
		}
		await new Promise((r) => setTimeout(r, delayMs))
		delayMs = Math.min(delayMs * 2, 1_000)
	}
	// Budget exhausted — surface violations as hard failure.
	await assertSeedState(tenantId)
}

const isCliEntry = typeof process !== 'undefined' && process.argv[1]?.includes('seed-demo-tenant')
if (isCliEntry) {
	runSeedDemoTenant()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error('❌ Seed failed:', err)
			process.exit(1)
		})
}
