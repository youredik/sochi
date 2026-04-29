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

import { sql } from './index.ts'
import { dateFromIso, NULL_INT32, toTs } from './ydb-helpers.ts'

const TENANT_ID = 'demo-sochi-sirius'
const SLUG = 'demo-sirius'

// M9.widget.1 — MVP property + roomTypes для public widget endpoint.
// Полный polish (5-7 rooms + photos + 14d availability + reviews + JSON-LD)
// — М9.widget.8 demo polish sub-phase.
const DEMO_PROPERTY_ID = 'demo-prop-sirius-main'
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
	await sql`
		UPSERT INTO organizationProfile (
			\`organizationId\`, \`plan\`, \`createdAt\`, \`updatedAt\`, \`mode\`,
			\`epguDefaultChannel\`, \`epguSupplierGid\`, \`epguRegionCodeFias\`
		) VALUES (
			${TENANT_ID}, ${'free'}, ${nowTs}, ${nowTs}, ${'demo'},
			${'gost-tls'}, ${'demo-supplier-gid'}, ${'demo-fias-sochi'}
		)
	`

	// M9.widget.1 — minimal property с isPublic=true для widget endpoint.
	console.log('  → Step 3/4: property (public, active, Сочи tourism tax 2%)')
	await sql`
		UPSERT INTO property (
			\`tenantId\`, \`id\`, \`name\`, \`address\`, \`city\`, \`timezone\`,
			\`tourismTaxRateBps\`, \`isActive\`, \`isPublic\`,
			\`createdAt\`, \`updatedAt\`
		) VALUES (
			${TENANT_ID}, ${DEMO_PROPERTY_ID},
			${'Гостиница Сириус — Морская резиденция'},
			${'Сириус, Олимпийский проспект 21'},
			${'Сириус'},
			${'Europe/Moscow'},
			${200},
			${true}, ${true},
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
			${5}, ${true}, ${nowTs}, ${nowTs}
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
			${10}, ${true}, ${nowTs}, ${nowTs}
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

	console.log('  → Step 6/7: 60-day availability calendar (2 roomTypes × 60 days = 120 rows)')
	const today = new Date()
	today.setUTCHours(0, 0, 0, 0)
	const dates: string[] = []
	for (let i = 0; i < 60; i++) {
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
			// Demo: light pseudo-sold pattern (5-10% sold) для realistic-feel availability.
			// Не критично для widget gating, но showcases «N rooms left» badge UI.
			const sold = Number.parseInt(dateIso.slice(8, 10), 10) % 7 === 0 ? 1 : 0
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

	console.log('  → Step 7/7: 60-day rates (4 ratePlans × 60 days = 240 rows)')
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

	console.log(`✅ Demo tenant ready: tenantId=${TENANT_ID} slug=${SLUG} mode=demo`)
	console.log(
		'   M9.widget.2 seed: 1 property + 2 roomTypes + 4 ratePlans + 120 avail rows + 240 rate rows.',
	)
	console.log('   Full polish (photos / reviews / JSON-LD) — M9.widget.8.')
	return { tenantId: TENANT_ID }
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
