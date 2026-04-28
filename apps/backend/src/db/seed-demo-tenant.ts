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
import { toTs } from './ydb-helpers.ts'

const TENANT_ID = 'demo-sochi-sirius'
const SLUG = 'demo-sirius'

export async function runSeedDemoTenant(): Promise<{ tenantId: string }> {
	console.log(`🌱 Seeding demo tenant: ${TENANT_ID}`)
	const now = new Date()
	const nowTs = toTs(now)

	console.log('  → Step 1/2: organization (BetterAuth row)')
	await sql`
		UPSERT INTO organization (id, name, slug, createdAt)
		VALUES (${TENANT_ID}, ${'Гостиница Сириус (демо)'}, ${SLUG}, ${now})
	`

	console.log('  → Step 2/2: organizationProfile с mode=demo + ЕПГУ config')
	await sql`
		UPSERT INTO organizationProfile (
			\`organizationId\`, \`plan\`, \`createdAt\`, \`updatedAt\`, \`mode\`,
			\`epguDefaultChannel\`, \`epguSupplierGid\`, \`epguRegionCodeFias\`
		) VALUES (
			${TENANT_ID}, ${'free'}, ${nowTs}, ${nowTs}, ${'demo'},
			${'gost-tls'}, ${'demo-supplier-gid'}, ${'demo-fias-sochi'}
		)
	`

	console.log(`✅ Demo tenant ready: tenantId=${TENANT_ID} slug=${SLUG} mode=demo`)
	console.log('   Full domain seed (property/rooms/bookings/guests) — M9 deploy phase.')
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
