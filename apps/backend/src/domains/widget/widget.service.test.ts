/**
 * Widget service — strict orchestration tests per `feedback_strict_tests.md`.
 *
 * Service layer = resolver + repo orchestration. Tests SPECIFICALLY for
 * orchestration paths NOT covered transitively by widget.routes.test.ts:
 *
 *   ─── Tenant resolution ────────────────────────────────────────
 *     [TR1] listProperties — unknown slug → throws TenantNotFoundError
 *           (not generic Error — specific class для типизированного catch)
 *     [TR2] getPropertyDetail — unknown slug → throws TenantNotFoundError
 *
 *   ─── Property resolution ──────────────────────────────────────
 *     [PR1] getPropertyDetail — known tenant + non-existent property →
 *           throws PublicPropertyNotFoundError (NOT TenantNotFoundError)
 *     [PR2] getPropertyDetail — property принадлежит другому tenant →
 *           throws PublicPropertyNotFoundError (cross-tenant leak guard)
 *
 *   ─── Mode passthrough ─────────────────────────────────────────
 *     [M1] tenant.mode='demo' → propagates в DTO
 *     [M2] tenant.mode='production' → propagates в DTO
 *     [M3] tenant без organizationProfile → mode=null (not omitted)
 *
 *   ─── Adversarial: data leakage ────────────────────────────────
 *     [AL1] listProperties returns PublicProperty type — NO `isPublic`
 *           field в response (internal flag должен скрываться)
 *     [AL2] returned tenant DTO has only {slug, name, mode} — NO `id`
 *           leak (tenantId — internal, не должен попасть к anonymous)
 *
 *   ─── M9.widget.3 Extras / Addons orchestration ────────────────
 *     [AD1] listAddons — unknown slug → TenantNotFoundError
 *     [AD2] listAddons — known tenant + non-existent property → PublicPropertyNotFoundError
 *     [AD3] listAddons — property принадлежит другому tenant → PublicPropertyNotFoundError
 *     [AD4] listAddons — wire format priceKopecks (number) NOT priceMicros (bigint)
 *     [AD5] listAddons — JSON.stringify(view) succeeds (no bigint leak)
 *     [AD6] listAddons — tenant.mode demo|production|null propagates в view
 */
import { fc } from '@fast-check/vitest'
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { dateFromIso, NULL_INT32 } from '../../db/ydb-helpers.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createWidgetFactory } from './widget.factory.ts'
import {
	InvalidAvailabilityInputError,
	PublicPropertyNotFoundError,
	TenantNotFoundError,
} from './widget.service.ts'

describe('widget.service — orchestration', { tags: ['db'], timeout: 60_000 }, () => {
	beforeAll(async () => {
		await setupTestDb()
	})

	afterAll(async () => {
		await teardownTestDb()
	})

	async function seedTenant(opts: {
		slug: string
		mode?: 'demo' | 'production' | null
		propertyId?: string
		propertyIsPublic?: boolean
	}) {
		const sql = getTestSql()
		const tenantId = newId('organization')
		const now = new Date()
		await sql`
			UPSERT INTO organization (id, name, slug, createdAt)
			VALUES (${tenantId}, ${'Test'}, ${opts.slug}, ${now})
		`
		if (opts.mode !== undefined) {
			await sql`
				UPSERT INTO organizationProfile (organizationId, plan, createdAt, updatedAt, mode)
				VALUES (${tenantId}, ${'free'}, ${now}, ${now}, ${opts.mode})
			`
		}
		if (opts.propertyId) {
			await sql`
				UPSERT INTO property (
					\`tenantId\`, \`id\`, \`name\`, \`address\`, \`city\`, \`timezone\`,
					\`isActive\`, \`isPublic\`, \`createdAt\`, \`updatedAt\`
				) VALUES (
					${tenantId}, ${opts.propertyId},
					${'Test Property'}, ${'addr'}, ${'Sochi'}, ${'Europe/Moscow'},
					${true}, ${opts.propertyIsPublic ?? true}, ${now}, ${now}
				)
			`
		}
		return { tenantId }
	}

	test('[TR1] listProperties — unknown slug → TenantNotFoundError (specific class)', async () => {
		const { service } = createWidgetFactory(getTestSql())
		await expect(service.listProperties(`tr1-nonexistent-${Date.now()}`)).rejects.toThrow(
			TenantNotFoundError,
		)
		// Adversarial: assert NOT a generic Error (typed catch matters)
		await expect(service.listProperties(`tr1-nonexistent-${Date.now()}`)).rejects.toBeInstanceOf(
			TenantNotFoundError,
		)
	})

	test('[TR2] getPropertyDetail — unknown slug → TenantNotFoundError', async () => {
		const { service } = createWidgetFactory(getTestSql())
		await expect(
			service.getPropertyDetail(`tr2-${Date.now()}`, newId('property')),
		).rejects.toBeInstanceOf(TenantNotFoundError)
	})

	test('[PR1] getPropertyDetail — known tenant + nonexistent property → PublicPropertyNotFoundError', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `pr1-${Date.now().toString(36)}`
		await seedTenant({ slug, mode: 'demo' })
		// NO property seeded
		await expect(service.getPropertyDetail(slug, newId('property'))).rejects.toBeInstanceOf(
			PublicPropertyNotFoundError,
		)
	})

	test('[PR2] getPropertyDetail — property принадлежит другому tenant → PublicPropertyNotFoundError (NOT a leak)', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slugA = `pr2a-${Date.now().toString(36)}`
		const slugB = `pr2b-${Date.now().toString(36)}`
		const propertyId = newId('property')
		await seedTenant({ slug: slugA, mode: 'demo', propertyId, propertyIsPublic: true })
		await seedTenant({ slug: slugB, mode: 'demo' })
		// Try get tenant A's property через tenant B's slug
		await expect(service.getPropertyDetail(slugB, propertyId)).rejects.toBeInstanceOf(
			PublicPropertyNotFoundError,
		)
	})

	test('[M1] tenant.mode=demo propagates в DTO', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `m1-${Date.now().toString(36)}`
		await seedTenant({ slug, mode: 'demo', propertyId: newId('property') })
		const view = await service.listProperties(slug)
		expect(view.tenant.mode).toBe('demo')
	})

	test('[M2] tenant.mode=production propagates в DTO', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `m2-${Date.now().toString(36)}`
		await seedTenant({ slug, mode: 'production', propertyId: newId('property') })
		const view = await service.listProperties(slug)
		expect(view.tenant.mode).toBe('production')
	})

	test('[M3] tenant без organizationProfile → mode=null (not undefined / not omitted)', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `m3-${Date.now().toString(36)}`
		await seedTenant({ slug }) // no mode → no organizationProfile row
		const view = await service.listProperties(slug)
		expect(view.tenant.mode).toBeNull()
		expect('mode' in view.tenant).toBe(true) // exact: mode key IS present
	})

	test('[AL1] PublicProperty DTO has NO isPublic field (internal flag не утечёт)', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `al1-${Date.now().toString(36)}`
		await seedTenant({ slug, mode: 'demo', propertyId: newId('property') })
		const view = await service.listProperties(slug)
		expect(view.properties.length).toBeGreaterThan(0)
		const firstProp = view.properties[0]!
		expect('isPublic' in firstProp).toBe(false)
		expect('isActive' in firstProp).toBe(false) // internal flag тоже не должен утечь
	})

	// ─── Property-based invariant ─────────────────────────────────
	// Random string input → service.listProperties либо resolves либо throws
	// ОНЛИ TenantNotFoundError. Никакого generic Error / TypeError leakage.
	test('[FC-S1] listProperties — any input string: resolves OR TenantNotFoundError invariant', async () => {
		const { service } = createWidgetFactory(getTestSql())
		await fc.assert(
			fc.asyncProperty(
				// Bound length to avoid pathological-long strings hitting URL limits
				fc.string({ minLength: 0, maxLength: 50 }),
				async (input) => {
					try {
						await service.listProperties(input)
						return true
					} catch (err) {
						if (err instanceof TenantNotFoundError) return true
						// Adversarial canon: ANY other error class = test failure
						console.error('Unexpected error class:', err)
						return false
					}
				},
			),
			{ numRuns: 30 }, // numRuns low — каждый run hits real DB
		)
	})

	test('[AL2] tenant DTO имеет только {slug,name,mode} — tenantId НЕ leaked', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `al2-${Date.now().toString(36)}`
		await seedTenant({ slug, mode: 'demo', propertyId: newId('property') })
		const view = await service.listProperties(slug)
		// Exact key set (immutable-field check per feedback_strict_tests.md)
		const tenantKeys = Object.keys(view.tenant).sort()
		expect(tenantKeys).toEqual(['mode', 'name', 'slug'])
		// Adversarial: verify tenantId NOT present под любым именем
		expect('id' in view.tenant).toBe(false)
		expect('tenantId' in view.tenant).toBe(false)
		expect('organizationId' in view.tenant).toBe(false)
	})

	// ─── M9.widget.2 — getAvailability orchestration ───────────────────
	async function seedFullAvailability(opts: {
		slug: string
		propertyId: string
		roomTypeId: string
		ratePlanId: string
		nightlyMicros: bigint
		checkIn: string
		checkOut: string
		inventory?: number
		soldOnFirst?: number
		stopSellOnFirst?: boolean
		closedToArrivalOnFirst?: boolean
		taxBps?: number
		isRefundable?: boolean
		cancelHours?: number | null
		minStay?: number
		maxStay?: number | null
	}) {
		const sql = getTestSql()
		const tenantId = newId('organization')
		const now = new Date()
		await sql`
			UPSERT INTO organization (id, name, slug, createdAt)
			VALUES (${tenantId}, ${'Test'}, ${opts.slug}, ${now})
		`
		await sql`
			UPSERT INTO organizationProfile (organizationId, plan, createdAt, updatedAt, mode)
			VALUES (${tenantId}, ${'free'}, ${now}, ${now}, ${'demo'})
		`
		await sql`
			UPSERT INTO property (
				\`tenantId\`, \`id\`, \`name\`, \`address\`, \`city\`, \`timezone\`,
				\`tourismTaxRateBps\`, \`isActive\`, \`isPublic\`, \`createdAt\`, \`updatedAt\`
			) VALUES (
				${tenantId}, ${opts.propertyId}, ${'Test Property'},
				${'addr'}, ${'Sochi'}, ${'Europe/Moscow'},
				${opts.taxBps ?? 200}, ${true}, ${true}, ${now}, ${now}
			)
		`
		await sql`
			UPSERT INTO roomType (
				\`tenantId\`, \`id\`, \`propertyId\`, \`name\`, \`description\`,
				\`maxOccupancy\`, \`baseBeds\`, \`extraBeds\`, \`areaSqm\`,
				\`inventoryCount\`, \`isActive\`, \`createdAt\`, \`updatedAt\`
			) VALUES (
				${tenantId}, ${opts.roomTypeId}, ${opts.propertyId},
				${'Test Room'}, ${'desc'},
				${2}, ${1}, ${0}, ${20},
				${opts.inventory ?? 5}, ${true}, ${now}, ${now}
			)
		`
		await sql`
			UPSERT INTO ratePlan (
				\`tenantId\`, \`id\`, \`propertyId\`, \`roomTypeId\`, \`name\`, \`code\`,
				\`isDefault\`, \`isRefundable\`, \`cancellationHours\`, \`mealsIncluded\`,
				\`minStay\`, \`maxStay\`, \`isActive\`, \`currency\`,
				\`createdAt\`, \`updatedAt\`
			) VALUES (
				${tenantId}, ${opts.ratePlanId}, ${opts.propertyId}, ${opts.roomTypeId},
				${'BAR Flex'}, ${'BAR_FLEX'}, ${true}, ${opts.isRefundable ?? true},
				${opts.cancelHours ?? 24}, ${'breakfast'},
				${opts.minStay ?? 1}, ${opts.maxStay ?? 30}, ${true}, ${'RUB'},
				${now}, ${now}
			)
		`
		// Enumerate dates locally (avoid pulling pricing helper here)
		const inMs = Date.UTC(
			Number(opts.checkIn.slice(0, 4)),
			Number(opts.checkIn.slice(5, 7)) - 1,
			Number(opts.checkIn.slice(8, 10)),
		)
		const outMs = Date.UTC(
			Number(opts.checkOut.slice(0, 4)),
			Number(opts.checkOut.slice(5, 7)) - 1,
			Number(opts.checkOut.slice(8, 10)),
		)
		const dates: string[] = []
		for (let t = inMs; t < outMs; t += 86_400_000) {
			const d = new Date(t)
			dates.push(
				`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
			)
		}
		for (const [i, dateIso] of dates.entries()) {
			const sold = i === 0 ? (opts.soldOnFirst ?? 0) : 0
			const stop = i === 0 ? (opts.stopSellOnFirst ?? false) : false
			const cta = i === 0 ? (opts.closedToArrivalOnFirst ?? false) : false
			await sql`
				UPSERT INTO availability (
					\`tenantId\`, \`propertyId\`, \`roomTypeId\`, \`date\`,
					\`allotment\`, \`sold\`, \`minStay\`, \`maxStay\`,
					\`closedToArrival\`, \`closedToDeparture\`, \`stopSell\`,
					\`createdAt\`, \`updatedAt\`
				) VALUES (
					${tenantId}, ${opts.propertyId}, ${opts.roomTypeId}, ${dateFromIso(dateIso)},
					${opts.inventory ?? 5}, ${sold}, ${NULL_INT32}, ${NULL_INT32},
					${cta}, ${false}, ${stop},
					${now}, ${now}
				)
			`
			await sql`
				UPSERT INTO rate (
					\`tenantId\`, \`propertyId\`, \`roomTypeId\`, \`ratePlanId\`, \`date\`,
					\`amountMicros\`, \`currency\`,
					\`createdAt\`, \`updatedAt\`
				) VALUES (
					${tenantId}, ${opts.propertyId}, ${opts.roomTypeId}, ${opts.ratePlanId},
					${dateFromIso(dateIso)},
					${opts.nightlyMicros}, ${'RUB'},
					${now}, ${now}
				)
			`
		}
		return { tenantId }
	}

	test('[AV1] happy path — 5 nights × 8000 RUB + 2% tax = 40000 + 800 = 40800', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `av1-${Date.now().toString(36)}`
		const propertyId = newId('property')
		const roomTypeId = newId('roomType')
		const ratePlanId = newId('ratePlan')
		await seedFullAvailability({
			slug,
			propertyId,
			roomTypeId,
			ratePlanId,
			nightlyMicros: 8_000_000_000n,
			checkIn: '2026-06-01',
			checkOut: '2026-06-06',
		})
		const result = await service.getAvailability({
			tenantSlug: slug,
			propertyId,
			checkIn: '2026-06-01',
			checkOut: '2026-06-06',
			adults: 2,
			children: 0,
		})
		expect(result.nights).toBe(5)
		expect(result.offerings).toHaveLength(1)
		const o = result.offerings[0]!
		expect(o.sellable).toBe(true)
		expect(o.unsellableReason).toBeNull()
		expect(o.rateOptions).toHaveLength(1)
		const ro = o.rateOptions[0]!
		expect(ro.subtotalKopecks).toBe(4_000_000) // 40000 RUB × 100
		expect(ro.tourismTaxKopecks).toBe(80_000) // 800 RUB × 100
		expect(ro.totalKopecks).toBe(4_080_000)
		expect(ro.avgPerNightKopecks).toBe(800_000) // 8000 RUB × 100
		expect(ro.code).toBe('BAR_FLEX')
		expect(ro.freeCancelDeadlineUtc).toBe('2026-05-31T11:00:00.000Z') // 24h before 2026-06-01 14:00 MSK
	})

	test('[AV2] occupancy filter — adults+children > maxOccupancy → roomType excluded', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `av2-${Date.now().toString(36)}`
		const propertyId = newId('property')
		const roomTypeId = newId('roomType')
		const ratePlanId = newId('ratePlan')
		await seedFullAvailability({
			slug,
			propertyId,
			roomTypeId,
			ratePlanId,
			nightlyMicros: 5_000_000_000n,
			checkIn: '2026-06-01',
			checkOut: '2026-06-02',
		})
		// roomType maxOccupancy=2 (per seed), запрашиваем 3 гостей
		const result = await service.getAvailability({
			tenantSlug: slug,
			propertyId,
			checkIn: '2026-06-01',
			checkOut: '2026-06-02',
			adults: 3,
			children: 0,
		})
		expect(result.offerings).toHaveLength(0)
	})

	test('[AV3] sold out — sold === allotment → sellable=false reason=sold_out', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `av3-${Date.now().toString(36)}`
		const propertyId = newId('property')
		const roomTypeId = newId('roomType')
		const ratePlanId = newId('ratePlan')
		await seedFullAvailability({
			slug,
			propertyId,
			roomTypeId,
			ratePlanId,
			nightlyMicros: 5_000_000_000n,
			checkIn: '2026-06-01',
			checkOut: '2026-06-02',
			inventory: 1,
			soldOnFirst: 1, // sold out
		})
		const result = await service.getAvailability({
			tenantSlug: slug,
			propertyId,
			checkIn: '2026-06-01',
			checkOut: '2026-06-02',
			adults: 2,
			children: 0,
		})
		expect(result.offerings).toHaveLength(1)
		const o = result.offerings[0]!
		expect(o.sellable).toBe(false)
		expect(o.unsellableReason).toBe('sold_out')
		expect(o.inventoryRemaining).toBe(0)
	})

	test('[AV4] stop_sell flag → reason=stop_sell', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `av4-${Date.now().toString(36)}`
		const propertyId = newId('property')
		const roomTypeId = newId('roomType')
		const ratePlanId = newId('ratePlan')
		await seedFullAvailability({
			slug,
			propertyId,
			roomTypeId,
			ratePlanId,
			nightlyMicros: 5_000_000_000n,
			checkIn: '2026-06-01',
			checkOut: '2026-06-02',
			stopSellOnFirst: true,
		})
		const result = await service.getAvailability({
			tenantSlug: slug,
			propertyId,
			checkIn: '2026-06-01',
			checkOut: '2026-06-02',
			adults: 2,
			children: 0,
		})
		const o = result.offerings[0]!
		expect(o.sellable).toBe(false)
		expect(o.unsellableReason).toBe('stop_sell')
	})

	test('[AV5] closedToArrival flag → reason=closed_to_arrival', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `av5-${Date.now().toString(36)}`
		const propertyId = newId('property')
		const roomTypeId = newId('roomType')
		const ratePlanId = newId('ratePlan')
		await seedFullAvailability({
			slug,
			propertyId,
			roomTypeId,
			ratePlanId,
			nightlyMicros: 5_000_000_000n,
			checkIn: '2026-06-01',
			checkOut: '2026-06-02',
			closedToArrivalOnFirst: true,
		})
		const result = await service.getAvailability({
			tenantSlug: slug,
			propertyId,
			checkIn: '2026-06-01',
			checkOut: '2026-06-02',
			adults: 2,
			children: 0,
		})
		expect(result.offerings[0]!.unsellableReason).toBe('closed_to_arrival')
	})

	test('[AV6] non-refundable rate → freeCancelDeadlineUtc=null', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `av6-${Date.now().toString(36)}`
		const propertyId = newId('property')
		const roomTypeId = newId('roomType')
		const ratePlanId = newId('ratePlan')
		await seedFullAvailability({
			slug,
			propertyId,
			roomTypeId,
			ratePlanId,
			nightlyMicros: 5_000_000_000n,
			checkIn: '2026-06-01',
			checkOut: '2026-06-02',
			isRefundable: false,
			cancelHours: null,
		})
		const result = await service.getAvailability({
			tenantSlug: slug,
			propertyId,
			checkIn: '2026-06-01',
			checkOut: '2026-06-02',
			adults: 2,
			children: 0,
		})
		expect(result.offerings[0]!.rateOptions[0]!.freeCancelDeadlineUtc).toBeNull()
		expect(result.offerings[0]!.rateOptions[0]!.isRefundable).toBe(false)
	})

	test('[AV7] minStay > nights → ratePlan dropped', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `av7-${Date.now().toString(36)}`
		const propertyId = newId('property')
		const roomTypeId = newId('roomType')
		const ratePlanId = newId('ratePlan')
		await seedFullAvailability({
			slug,
			propertyId,
			roomTypeId,
			ratePlanId,
			nightlyMicros: 5_000_000_000n,
			checkIn: '2026-06-01',
			checkOut: '2026-06-02', // 1 night
			minStay: 3, // requires 3
		})
		const result = await service.getAvailability({
			tenantSlug: slug,
			propertyId,
			checkIn: '2026-06-01',
			checkOut: '2026-06-02',
			adults: 2,
			children: 0,
		})
		expect(result.offerings[0]!.rateOptions).toHaveLength(0)
		expect(result.offerings[0]!.sellable).toBe(false)
	})

	test('[AV8] cross-tenant property → PublicPropertyNotFoundError (no leak)', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slugA = `av8a-${Date.now().toString(36)}`
		const slugB = `av8b-${Date.now().toString(36)}`
		const propertyId = newId('property')
		const roomTypeId = newId('roomType')
		const ratePlanId = newId('ratePlan')
		await seedFullAvailability({
			slug: slugA,
			propertyId,
			roomTypeId,
			ratePlanId,
			nightlyMicros: 5_000_000_000n,
			checkIn: '2026-06-01',
			checkOut: '2026-06-02',
		})
		// Tenant B exists; ask its slug for tenant A's property
		const sql = getTestSql()
		const tBId = newId('organization')
		await sql`UPSERT INTO organization (id, name, slug, createdAt) VALUES (${tBId}, ${'B'}, ${slugB}, ${new Date()})`
		await expect(
			service.getAvailability({
				tenantSlug: slugB,
				propertyId,
				checkIn: '2026-06-01',
				checkOut: '2026-06-02',
				adults: 2,
				children: 0,
			}),
		).rejects.toBeInstanceOf(PublicPropertyNotFoundError)
	})

	test('[AV9] invalid date range (checkOut <= checkIn) → InvalidAvailabilityInputError', async () => {
		const { service } = createWidgetFactory(getTestSql())
		await expect(
			service.getAvailability({
				tenantSlug: 'whatever',
				propertyId: 'prop',
				checkIn: '2026-06-05',
				checkOut: '2026-06-05', // equal → invalid
				adults: 2,
				children: 0,
			}),
		).rejects.toBeInstanceOf(InvalidAvailabilityInputError)
	})

	test('[AV10] adults < 1 → InvalidAvailabilityInputError', async () => {
		const { service } = createWidgetFactory(getTestSql())
		await expect(
			service.getAvailability({
				tenantSlug: 'whatever',
				propertyId: 'prop',
				checkIn: '2026-06-01',
				checkOut: '2026-06-02',
				adults: 0,
				children: 0,
			}),
		).rejects.toBeInstanceOf(InvalidAvailabilityInputError)
	})

	test('[AV11] stay > 30 nights → InvalidAvailabilityInputError', async () => {
		const { service } = createWidgetFactory(getTestSql())
		await expect(
			service.getAvailability({
				tenantSlug: 'whatever',
				propertyId: 'prop',
				checkIn: '2026-06-01',
				checkOut: '2026-08-01', // 61 nights
				adults: 2,
				children: 0,
			}),
		).rejects.toBeInstanceOf(InvalidAvailabilityInputError)
	})

	test('[FC-AV] getAvailability — random adults/children/dates: resolves OR throws Invalid|TenantNotFound|PublicPropertyNotFound (никаких unknown errors)', async () => {
		const { service } = createWidgetFactory(getTestSql())
		await fc.assert(
			fc.asyncProperty(
				fc.string({ minLength: 0, maxLength: 30 }),
				fc.string({ minLength: 0, maxLength: 30 }),
				fc.integer({ min: -2, max: 12 }),
				fc.integer({ min: -1, max: 8 }),
				fc.date({ min: new Date('2026-01-01'), max: new Date('2027-01-01') }),
				fc.integer({ min: -10, max: 60 }),
				async (slug, propId, adults, children, checkInDate, checkOutDelta) => {
					const checkIn = checkInDate.toISOString().slice(0, 10)
					const checkOutDate = new Date(checkInDate)
					checkOutDate.setUTCDate(checkOutDate.getUTCDate() + checkOutDelta)
					const checkOut = checkOutDate.toISOString().slice(0, 10)
					try {
						await service.getAvailability({
							tenantSlug: slug,
							propertyId: propId,
							checkIn,
							checkOut,
							adults,
							children,
						})
						return true
					} catch (err) {
						if (
							err instanceof InvalidAvailabilityInputError ||
							err instanceof TenantNotFoundError ||
							err instanceof PublicPropertyNotFoundError
						) {
							return true
						}
						console.error('Unexpected error class:', err)
						return false
					}
				},
			),
			{ numRuns: 25 }, // numRuns low — каждый run hits real DB
		)
	})

	async function seedAddon(opts: {
		tenantId: string
		propertyId: string
		addonId: string
		code: string
		isActive?: boolean
		isMandatory?: boolean
		inventoryMode?: 'NONE' | 'DAILY_COUNTER' | 'TIME_SLOT'
		dailyCapacity?: number | null
		priceMicros?: bigint
		vatBps?: number
	}) {
		const sql = getTestSql()
		const now = new Date()
		const dailyCapacityParam =
			opts.dailyCapacity === undefined || opts.dailyCapacity === null
				? NULL_INT32
				: opts.dailyCapacity
		await sql`
			UPSERT INTO propertyAddon (
				\`tenantId\`, \`propertyId\`, \`addonId\`,
				\`code\`, \`category\`,
				\`nameRu\`, \`pricingUnit\`, \`priceMicros\`, \`currency\`, \`vatBps\`,
				\`isActive\`, \`isMandatory\`,
				\`inventoryMode\`, \`dailyCapacity\`,
				\`seasonalTagsJson\`, \`sortOrder\`,
				\`createdAt\`, \`createdBy\`, \`updatedAt\`, \`updatedBy\`
			) VALUES (
				${opts.tenantId}, ${opts.propertyId}, ${opts.addonId},
				${opts.code}, ${'FOOD_AND_BEVERAGES'},
				${'Завтрак'}, ${'PER_NIGHT_PER_PERSON'},
				${opts.priceMicros ?? 1_500_000_000n},
				${'RUB'}, ${opts.vatBps ?? 2200},
				${opts.isActive ?? true}, ${opts.isMandatory ?? false},
				${opts.inventoryMode ?? 'NONE'},
				${dailyCapacityParam},
				${'[]'}, ${0},
				${now}, ${'test'}, ${now}, ${'test'}
			)
		`
	}

	test('[AD1] listAddons — unknown slug → TenantNotFoundError (specific class)', async () => {
		const { service } = createWidgetFactory(getTestSql())
		await expect(service.listAddons(`ad1-nonexistent-${Date.now()}`, 'p1')).rejects.toThrow(
			TenantNotFoundError,
		)
		await expect(service.listAddons(`ad1-nonexistent-${Date.now()}`, 'p1')).rejects.toBeInstanceOf(
			TenantNotFoundError,
		)
	})

	test('[AD2] listAddons — known tenant + missing property → PublicPropertyNotFoundError', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `ad2-${Date.now().toString(36)}`
		await seedTenant({ slug })
		await expect(service.listAddons(slug, newId('property'))).rejects.toThrow(
			PublicPropertyNotFoundError,
		)
	})

	test('[AD3] listAddons — cross-tenant: property другого tenant → PublicPropertyNotFoundError', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slugA = `ad3a-${Date.now().toString(36)}`
		const slugB = `ad3b-${Date.now().toString(36)}`
		const propertyId = newId('property')
		const addonId = newId('addon')
		const { tenantId: tenantA } = await seedTenant({
			slug: slugA,
			propertyId,
			propertyIsPublic: true,
		})
		await seedAddon({ tenantId: tenantA, propertyId, addonId, code: 'AD3' })
		await seedTenant({ slug: slugB })
		// Tenant B запрашивает property tenant A's via своего slug → 404 (cross-tenant guard)
		await expect(service.listAddons(slugB, propertyId)).rejects.toThrow(PublicPropertyNotFoundError)
	})

	test('[AD4] listAddons — wire format priceKopecks (number) NOT priceMicros (bigint)', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `ad4-${Date.now().toString(36)}`
		const propertyId = newId('property')
		const addonId = newId('addon')
		const { tenantId } = await seedTenant({ slug, propertyId, propertyIsPublic: true })
		// 1500₽ = 1500 × 100 коп = 150_000 kopecks = 1_500_000_000 micros
		await seedAddon({
			tenantId,
			propertyId,
			addonId,
			code: 'AD4_BREAKFAST',
			priceMicros: 1_500_000_000n,
		})
		const view = await service.listAddons(slug, propertyId)
		expect(view.addons).toHaveLength(1)
		const a = view.addons[0]!
		expect(typeof a.priceKopecks).toBe('number')
		expect(a.priceKopecks).toBe(150_000)
		// Adversarial: ensure no bigint leak в DTO (TS type не имеет priceMicros, runtime check)
		expect(a).not.toHaveProperty('priceMicros')
	})

	test('[AD5] listAddons — JSON.stringify(view) succeeds (no bigint leak)', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `ad5-${Date.now().toString(36)}`
		const propertyId = newId('property')
		const addonId = newId('addon')
		const { tenantId } = await seedTenant({ slug, propertyId, propertyIsPublic: true })
		await seedAddon({ tenantId, propertyId, addonId, code: 'AD5_OK' })
		const view = await service.listAddons(slug, propertyId)
		expect(() => JSON.stringify(view)).not.toThrow()
	})

	test('[AD6] listAddons — tenant.mode propagates (demo / production / null)', async () => {
		const { service } = createWidgetFactory(getTestSql())
		// demo mode
		const slugDemo = `ad6d-${Date.now().toString(36)}`
		const propDemo = newId('property')
		const addonDemo = newId('addon')
		const { tenantId: tenantD } = await seedTenant({
			slug: slugDemo,
			mode: 'demo',
			propertyId: propDemo,
			propertyIsPublic: true,
		})
		await seedAddon({ tenantId: tenantD, propertyId: propDemo, addonId: addonDemo, code: 'AD6D' })
		const viewDemo = await service.listAddons(slugDemo, propDemo)
		expect(viewDemo.tenant.mode).toBe('demo')

		// production mode
		const slugProd = `ad6p-${Date.now().toString(36)}`
		const propProd = newId('property')
		const addonProd = newId('addon')
		const { tenantId: tenantP } = await seedTenant({
			slug: slugProd,
			mode: 'production',
			propertyId: propProd,
			propertyIsPublic: true,
		})
		await seedAddon({ tenantId: tenantP, propertyId: propProd, addonId: addonProd, code: 'AD6P' })
		const viewProd = await service.listAddons(slugProd, propProd)
		expect(viewProd.tenant.mode).toBe('production')

		// null (tenant без organizationProfile)
		const slugNull = `ad6n-${Date.now().toString(36)}`
		const propNull = newId('property')
		const addonNull = newId('addon')
		const { tenantId: tenantN } = await seedTenant({
			slug: slugNull,
			propertyId: propNull,
			propertyIsPublic: true,
		})
		await seedAddon({ tenantId: tenantN, propertyId: propNull, addonId: addonNull, code: 'AD6N' })
		const viewNull = await service.listAddons(slugNull, propNull)
		expect(viewNull.tenant.mode).toBeNull()
	})

	test('[AV12] kopecks values are JSON-safe numbers (no bigint leak в DTO)', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `av12-${Date.now().toString(36)}`
		const propertyId = newId('property')
		const roomTypeId = newId('roomType')
		const ratePlanId = newId('ratePlan')
		await seedFullAvailability({
			slug,
			propertyId,
			roomTypeId,
			ratePlanId,
			nightlyMicros: 8_000_000_000n,
			checkIn: '2026-06-01',
			checkOut: '2026-06-02',
		})
		const result = await service.getAvailability({
			tenantSlug: slug,
			propertyId,
			checkIn: '2026-06-01',
			checkOut: '2026-06-02',
			adults: 2,
			children: 0,
		})
		const ro = result.offerings[0]!.rateOptions[0]!
		expect(typeof ro.subtotalKopecks).toBe('number')
		expect(typeof ro.tourismTaxKopecks).toBe('number')
		expect(typeof ro.totalKopecks).toBe('number')
		// JSON round-trip succeeds (no bigint leak)
		expect(() => JSON.stringify(result)).not.toThrow()
	})
})
