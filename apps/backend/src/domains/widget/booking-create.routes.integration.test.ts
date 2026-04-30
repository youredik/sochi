/**
 * HTTP integration tests для widget booking-create routes (M9.widget.4 / Track A2).
 *
 * Mounts the FULL middleware chain (CORS + CSP + tenant-resolver + idempotency
 * + Zod validation) и calls real services с real YDB. Mirrors widget.routes.test.ts
 * pattern.
 *
 * Test matrix per `feedback_pre_done_audit.md`:
 *
 *   ─── Headers / Security ──────────────────────────────────────
 *     [BCR1] CSP header set с ЮKassa + SmartCaptcha allowlists
 *     [BCR2] X-Content-Type-Options: nosniff
 *     [BCR3] Referrer-Policy: strict-origin-when-cross-origin
 *     [BCR4] CORS preflight OPTIONS returns Allow-Origin
 *     [BCR5] CORS allows Idempotency-Key header
 *
 *   ─── 404 / 400 / 422 paths ───────────────────────────────────
 *     [BCR6] Unknown slug → 404 NOT_FOUND
 *     [BCR7] Malformed body → 400 (Zod validation)
 *     [BCR8] Missing 152-ФЗ consent → 422 WIDGET_CONSENT_MISSING
 *     [BCR9] Stale price → 409 STALE_AVAILABILITY
 *
 *   ─── Happy path / Idempotency ────────────────────────────────
 *     [BCR10] Valid POST → 200 + canonical DTO shape
 *     [BCR11] Idempotency replay (same key + body) → cached response
 *     [BCR12] Idempotency conflict (same key, diff body) → 422
 *
 *   ─── No bigint leak (JSON safety) ────────────────────────────
 *     [BCR13] Response body NO 'n' suffix (no bigint leak)
 *
 *   ─── Cross-tenant isolation ──────────────────────────────────
 *     [BCR14] Tenant A booking NOT visible from tenant B's slug context
 */

import { newId } from '@horeca/shared'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { dateFromIso } from '../../db/ydb-helpers.ts'
import { onError } from '../../errors/on-error.ts'
import type { AppEnv } from '../../factory.ts'
import { createIdempotencyRepo } from '../../middleware/idempotency.repo.ts'
import { idempotencyMiddleware } from '../../middleware/idempotency.ts'
import { noopRateLimiter } from '../../middleware/widget-rate-limit.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createAvailabilityFactory } from '../availability/availability.factory.ts'
import { createBookingFactory } from '../booking/booking.factory.ts'
import { createFolioFactory } from '../folio/folio.factory.ts'
import { createGuestFactory } from '../guest/guest.factory.ts'
import { createPaymentFactory } from '../payment/payment.factory.ts'
import { createStubPaymentProvider } from '../payment/provider/stub-provider.ts'
import { createPropertyFactory } from '../property/property.factory.ts'
import { createRateFactory } from '../rate/rate.factory.ts'
import { createRatePlanFactory } from '../ratePlan/ratePlan.factory.ts'
import { createRoomTypeFactory } from '../roomType/roomType.factory.ts'
import { createWidgetBookingCreateFactory } from './booking-create.factory.ts'
import { createWidgetBookingCreateRoutes } from './booking-create.routes.ts'
import { createWidgetFactory } from './widget.factory.ts'

describe('widget booking-create routes — HTTP', { tags: ['db'], timeout: 90_000 }, () => {
	let app: Hono<AppEnv>

	beforeAll(async () => {
		await setupTestDb()
		const sql = getTestSql()
		const propertyFactory = createPropertyFactory(sql)
		const roomTypeFactory = createRoomTypeFactory(sql, propertyFactory.service)
		const ratePlanFactory = createRatePlanFactory(
			sql,
			propertyFactory.service,
			roomTypeFactory.service,
		)
		const rateFactory = createRateFactory(sql, ratePlanFactory.service)
		const _availabilityFactory = createAvailabilityFactory(sql, roomTypeFactory.service)
		const bookingFactory = createBookingFactory(
			sql,
			rateFactory.repo,
			propertyFactory.service,
			roomTypeFactory.service,
			ratePlanFactory.service,
		)
		const guestFactory = createGuestFactory(sql)
		const folioFactory = createFolioFactory(sql)
		const paymentProvider = createStubPaymentProvider()
		const paymentFactory = createPaymentFactory(sql, paymentProvider, folioFactory.service)
		const widgetFactory = createWidgetFactory(sql)
		const idempotencyRepo = createIdempotencyRepo(sql)
		const widgetBookingCreateFactory = createWidgetBookingCreateFactory({
			sql,
			widgetService: widgetFactory.service,
			guestService: guestFactory.service,
			bookingService: bookingFactory.service,
			paymentService: paymentFactory.service,
		})
		app = new Hono<AppEnv>().route(
			'/api/public/widget',
			createWidgetBookingCreateRoutes({
				service: widgetBookingCreateFactory.service,
				idempotency: idempotencyMiddleware(idempotencyRepo),
				// Disable rate-limit для BCR1-14 (these test schema/validation/idempotency,
				// not anti-abuse). Dedicated 429 tests live в booking-create.rate-limit.test.ts.
				burstRateLimiter: noopRateLimiter,
				steadyRateLimiter: noopRateLimiter,
			}),
		)
		app.onError(onError)
	})

	afterAll(async () => {
		await teardownTestDb()
	})

	function buildDates(): { checkIn: string; checkOut: string; nights: string[] } {
		const today = new Date()
		const ci = new Date(today)
		ci.setUTCDate(today.getUTCDate() + 30)
		const co = new Date(ci)
		co.setUTCDate(ci.getUTCDate() + 3)
		const fmt = (d: Date) =>
			`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
		const checkIn = fmt(ci)
		const checkOut = fmt(co)
		const nights: string[] = []
		for (let i = 0; i < 3; i++) {
			const d = new Date(ci)
			d.setUTCDate(ci.getUTCDate() + i)
			nights.push(fmt(d))
		}
		return { checkIn, checkOut, nights }
	}

	async function seedTenant(slug: string, amountDecimal = '5000.00') {
		const sql = getTestSql()
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const roomTypeId = newId('roomType')
		const ratePlanId = newId('ratePlan')
		const now = new Date()
		const dates = buildDates()

		await sql`
			UPSERT INTO organization (id, name, slug, createdAt)
			VALUES (${tenantId}, ${'Test'}, ${slug}, ${now})
		`
		await sql`
			UPSERT INTO property (
				\`tenantId\`, \`id\`, \`name\`, \`address\`, \`city\`, \`timezone\`,
				\`tourismTaxRateBps\`, \`isActive\`, \`isPublic\`, \`createdAt\`, \`updatedAt\`
			) VALUES (
				${tenantId}, ${propertyId},
				${'Test Property'}, ${'addr'}, ${'Сочи'}, ${'Europe/Moscow'},
				${200}, ${true}, ${true}, ${now}, ${now}
			)
		`
		await sql`
			UPSERT INTO roomType (
				\`tenantId\`, \`id\`, \`propertyId\`, \`name\`, \`description\`,
				\`maxOccupancy\`, \`baseBeds\`, \`extraBeds\`, \`areaSqm\`,
				\`inventoryCount\`, \`isActive\`, \`createdAt\`, \`updatedAt\`
			) VALUES (
				${tenantId}, ${roomTypeId}, ${propertyId},
				${'Standard'}, ${'desc'},
				${2}, ${1}, ${0}, ${20},
				${5}, ${true}, ${now}, ${now}
			)
		`
		await sql`
			UPSERT INTO ratePlan (
				\`tenantId\`, \`id\`, \`propertyId\`, \`roomTypeId\`, \`name\`, \`code\`,
				\`isDefault\`, \`isRefundable\`, \`cancellationHours\`, \`mealsIncluded\`,
				\`minStay\`, \`isActive\`, \`currency\`, \`createdAt\`, \`updatedAt\`
			) VALUES (
				${tenantId}, ${ratePlanId}, ${propertyId}, ${roomTypeId},
				${'BAR Flex'}, ${`BAR-${slug}`}, ${true}, ${true}, ${24}, ${'none'},
				${1}, ${true}, ${'RUB'},
				${now}, ${now}
			)
		`
		// Rates + availability
		const amountMicros = BigInt(Math.round(Number(amountDecimal) * 1_000_000))
		for (const date of dates.nights) {
			await sql`
				UPSERT INTO rate (
					\`tenantId\`, \`propertyId\`, \`roomTypeId\`, \`ratePlanId\`, \`date\`,
					\`amountMicros\`, \`currency\`, \`createdAt\`, \`updatedAt\`
				) VALUES (
					${tenantId}, ${propertyId}, ${roomTypeId}, ${ratePlanId}, ${dateFromIso(date)},
					${amountMicros}, ${'RUB'}, ${now}, ${now}
				)
			`
			await sql`
				UPSERT INTO availability (
					\`tenantId\`, \`propertyId\`, \`roomTypeId\`, \`date\`,
					\`allotment\`, \`sold\`, \`closedToArrival\`, \`closedToDeparture\`, \`stopSell\`,
					\`createdAt\`, \`updatedAt\`
				) VALUES (
					${tenantId}, ${propertyId}, ${roomTypeId}, ${dateFromIso(date)},
					${5}, ${0}, ${false}, ${false}, ${false},
					${now}, ${now}
				)
			`
		}
		return { tenantId, propertyId, roomTypeId, ratePlanId, slug, ...dates }
	}

	function buildBody(
		seed: {
			propertyId: string
			roomTypeId: string
			ratePlanId: string
			checkIn: string
			checkOut: string
		},
		overrides: Record<string, unknown> = {},
	) {
		return JSON.stringify({
			propertyId: seed.propertyId,
			checkIn: seed.checkIn,
			checkOut: seed.checkOut,
			adults: 2,
			children: 0,
			roomTypeId: seed.roomTypeId,
			ratePlanId: seed.ratePlanId,
			expectedTotalKopecks: 1_530_000, // 3 nights × 5000 + 2% tourism tax
			addons: [],
			guest: {
				firstName: 'Иван',
				lastName: 'Иванов',
				email: 'ivan@example.ru',
				phone: '+79991234567',
				citizenship: 'RU',
			},
			consents: { acceptedDpa: true, acceptedMarketing: false },
			consentSnapshot: {
				dpaText: 'Я даю согласие согласно 152-ФЗ',
				marketingText: 'Я согласен на маркетинговые рассылки',
				version: 'v1.0',
			},
			paymentMethod: 'card',
			...overrides,
		})
	}

	test('[BCR1] CSP header set с ЮKassa + SmartCaptcha allowlists', async () => {
		const seed = await seedTenant(`bcr1-${Date.now().toString(36)}`)
		const res = await app.request(`/api/public/widget/${seed.slug}/booking`, {
			method: 'POST',
			body: buildBody(seed),
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `bcr1-${Date.now()}` },
		})
		expect(res.status).toBe(200)
		const csp = res.headers.get('content-security-policy')
		expect(csp).toBeTruthy()
		expect(csp).toContain('https://yookassa.ru')
		expect(csp).toContain('https://smartcaptcha.cloud.yandex.ru')
	})

	test('[BCR2] X-Content-Type-Options: nosniff', async () => {
		const seed = await seedTenant(`bcr2-${Date.now().toString(36)}`)
		const res = await app.request(`/api/public/widget/${seed.slug}/booking`, {
			method: 'POST',
			body: buildBody(seed),
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `bcr2-${Date.now()}` },
		})
		expect(res.headers.get('x-content-type-options')).toBe('nosniff')
	})

	test('[BCR3] Referrer-Policy: strict-origin-when-cross-origin', async () => {
		const seed = await seedTenant(`bcr3-${Date.now().toString(36)}`)
		const res = await app.request(`/api/public/widget/${seed.slug}/booking`, {
			method: 'POST',
			body: buildBody(seed),
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `bcr3-${Date.now()}` },
		})
		expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
	})

	test('[BCR4] CORS preflight OPTIONS returns Allow-Origin', async () => {
		const seed = await seedTenant(`bcr4-${Date.now().toString(36)}`)
		const res = await app.request(`/api/public/widget/${seed.slug}/booking`, {
			method: 'OPTIONS',
			headers: { Origin: 'https://hotel.example.com' },
		})
		expect(res.status).toBeLessThan(400)
		expect(res.headers.get('access-control-allow-origin')).toBeTruthy()
	})

	test('[BCR5] CORS allows Idempotency-Key header', async () => {
		const seed = await seedTenant(`bcr5-${Date.now().toString(36)}`)
		const res = await app.request(`/api/public/widget/${seed.slug}/booking`, {
			method: 'OPTIONS',
			headers: {
				Origin: 'https://hotel.example.com',
				'Access-Control-Request-Headers': 'Idempotency-Key,Content-Type',
				'Access-Control-Request-Method': 'POST',
			},
		})
		const allowHeaders = res.headers.get('access-control-allow-headers')
		expect(allowHeaders?.toLowerCase()).toContain('idempotency-key')
	})

	test('[BCR6] Unknown slug → 404 NOT_FOUND', async () => {
		const res = await app.request(`/api/public/widget/never-exists-${Date.now()}/booking`, {
			method: 'POST',
			body: '{}',
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `bcr6-${Date.now()}` },
		})
		expect(res.status).toBe(404)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('NOT_FOUND')
	})

	test('[BCR7] Malformed body → 400 (Zod validation)', async () => {
		const seed = await seedTenant(`bcr7-${Date.now().toString(36)}`)
		const res = await app.request(`/api/public/widget/${seed.slug}/booking`, {
			method: 'POST',
			body: '{"missing":"required-fields"}',
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `bcr7-${Date.now()}` },
		})
		expect(res.status).toBe(400)
	})

	test('[BCR8] Missing 152-ФЗ consent → 422 WIDGET_CONSENT_MISSING', async () => {
		const seed = await seedTenant(`bcr8-${Date.now().toString(36)}`)
		const res = await app.request(`/api/public/widget/${seed.slug}/booking`, {
			method: 'POST',
			body: buildBody(seed, { consents: { acceptedDpa: false, acceptedMarketing: false } }),
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `bcr8-${Date.now()}` },
		})
		expect(res.status).toBe(422)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('WIDGET_CONSENT_MISSING')
	})

	test('[BCR9] Stale price → 409 STALE_AVAILABILITY', async () => {
		const seed = await seedTenant(`bcr9-${Date.now().toString(36)}`)
		const res = await app.request(`/api/public/widget/${seed.slug}/booking`, {
			method: 'POST',
			body: buildBody(seed, { expectedTotalKopecks: 99_999 }),
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `bcr9-${Date.now()}` },
		})
		expect(res.status).toBe(409)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('STALE_AVAILABILITY')
	})

	test('[BCR10] Valid POST → 200 + canonical DTO', async () => {
		const seed = await seedTenant(`bcr10-${Date.now().toString(36)}`)
		const res = await app.request(`/api/public/widget/${seed.slug}/booking`, {
			method: 'POST',
			body: buildBody(seed),
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `bcr10-${Date.now()}` },
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			data: {
				bookingId: string
				guestId: string
				paymentId: string
				paymentStatus: string
				confirmationToken: string | null
				totalKopecks: number
			}
		}
		expect(body.data.bookingId).toMatch(/^book_/)
		expect(body.data.guestId).toMatch(/^gst_/)
		expect(body.data.paymentId).toMatch(/^pay_/)
		expect(body.data.paymentStatus).toBe('succeeded')
		expect(body.data.totalKopecks).toBe(1_530_000)
		expect(body.data.confirmationToken).toBeTruthy()
	})

	test('[BCR11] Idempotency replay (same key + body) → cached response', async () => {
		const seed = await seedTenant(`bcr11-${Date.now().toString(36)}`)
		const key = `bcr11-replay-${Date.now()}`
		const body = buildBody(seed)
		const res1 = await app.request(`/api/public/widget/${seed.slug}/booking`, {
			method: 'POST',
			body,
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
		})
		const text1 = await res1.text()
		const res2 = await app.request(`/api/public/widget/${seed.slug}/booking`, {
			method: 'POST',
			body,
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
		})
		const text2 = await res2.text()
		expect(text2).toBe(text1)
	})

	test('[BCR12] Idempotency conflict (same key, diff body) → 422', async () => {
		const seed = await seedTenant(`bcr12-${Date.now().toString(36)}`)
		const key = `bcr12-conflict-${Date.now()}`
		const res1 = await app.request(`/api/public/widget/${seed.slug}/booking`, {
			method: 'POST',
			body: buildBody(seed),
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
		})
		expect(res1.status).toBe(200)
		// Same key, different body
		const res2 = await app.request(`/api/public/widget/${seed.slug}/booking`, {
			method: 'POST',
			body: buildBody(seed, { adults: 1 }),
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
		})
		expect(res2.status).toBe(422)
		const body = (await res2.json()) as { error: { code: string } }
		expect(body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT')
	})

	test('[BCR13] Response body NO bigint leak (no n suffix)', async () => {
		const seed = await seedTenant(`bcr13-${Date.now().toString(36)}`)
		const res = await app.request(`/api/public/widget/${seed.slug}/booking`, {
			method: 'POST',
			body: buildBody(seed),
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `bcr13-${Date.now()}` },
		})
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).not.toMatch(/\d+n[",}\]]/)
	})

	test('[BCR14] Cross-tenant: tenant A booking NOT visible from tenant B context (slug isolation)', async () => {
		const seedA = await seedTenant(`bcr14a-${Date.now().toString(36)}`)
		// Tenant B exists but with no property — slug-routed only к its own tenantId
		const sql = getTestSql()
		const tenantB = newId('organization')
		const slugB = `bcr14b-${Date.now().toString(36)}`
		await sql`
			UPSERT INTO organization (id, name, slug, createdAt)
			VALUES (${tenantB}, ${'B'}, ${slugB}, ${new Date()})
		`
		// Sending tenant A's body через tenant B's slug — propertyId belongs to A
		// but slug routes к B → tenant-resolver loads tenantId=B, then service
		// tries to validate availability for tenant B which has no such property
		// → StaleAvailabilityError or PublicPropertyNotFoundError.
		const res = await app.request(`/api/public/widget/${slugB}/booking`, {
			method: 'POST',
			body: buildBody(seedA),
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `bcr14-${Date.now()}` },
		})
		// Either 404 (property not found in tenant B scope) or 409 (stale)
		expect([404, 409]).toContain(res.status)
	})
})

/**
 * Dedicated 429 path tests (BCR15-17) — full middleware chain с low-cap rate
 * limiter. Splits из main describe, чтобы не requires real seed (limiter
 * fires BEFORE tenant-resolver, no DB lookup needed).
 */
describe('widget booking-create routes — 429 anti-abuse', { timeout: 30_000 }, () => {
	test('[BCR15] Burst limit exhausted → 429 + RateLimit headers', async () => {
		const { makeTestRateLimiter, noopRateLimiter } = await import(
			'../../middleware/widget-rate-limit.ts'
		)
		const lowCapBurst = makeTestRateLimiter({ limit: 2, windowMs: 60_000 })

		// Build minimal route — service / idempotency не reachable до 429 fires.
		const app = new Hono<AppEnv>().route(
			'/api/public/widget',
			createWidgetBookingCreateRoutes({
				// biome-ignore lint/suspicious/noExplicitAny: service unreachable past 429 — minimal mock OK
				service: { commit: () => Promise.resolve({}) } as any,
				// biome-ignore lint/suspicious/noExplicitAny: idempotency unreachable past 429 — pass-through OK
				idempotency: (async (_c: unknown, next: () => Promise<void>) => next()) as any,
				burstRateLimiter: lowCapBurst,
				steadyRateLimiter: noopRateLimiter,
			}),
		)
		app.onError(onError)

		const headers = { 'x-forwarded-for': '203.0.113.99', 'Content-Type': 'application/json' }
		const r1 = await app.request('/api/public/widget/any-slug/booking', {
			method: 'POST',
			body: '{}',
			headers,
		})
		const r2 = await app.request('/api/public/widget/any-slug/booking', {
			method: 'POST',
			body: '{}',
			headers,
		})
		const r3 = await app.request('/api/public/widget/any-slug/booking', {
			method: 'POST',
			body: '{}',
			headers,
		})

		// First two pass burst (then 400/422 from validator since body invalid; OK).
		expect([200, 400, 404, 422]).toContain(r1.status)
		expect([200, 400, 404, 422]).toContain(r2.status)
		// Third = 429 — rate-limit BEFORE validator
		expect(r3.status).toBe(429)

		const body = (await r3.json()) as { error: { code: string; message: string } }
		expect(body.error.code).toBe('RATE_LIMITED')
		expect(body.error.message).toMatch(/Слишком много запросов/)

		const rl = r3.headers.get('RateLimit')
		expect(rl).toMatch(/limit=2/)
		expect(rl).toMatch(/remaining=0/)
	})

	test('[BCR16] Different IPs do NOT share rate-limit bucket', async () => {
		const { makeTestRateLimiter, noopRateLimiter } = await import(
			'../../middleware/widget-rate-limit.ts'
		)
		const lowCapBurst = makeTestRateLimiter({ limit: 1, windowMs: 60_000 })
		const app = new Hono<AppEnv>().route(
			'/api/public/widget',
			createWidgetBookingCreateRoutes({
				// biome-ignore lint/suspicious/noExplicitAny: minimal stub
				service: { commit: () => Promise.resolve({}) } as any,
				// biome-ignore lint/suspicious/noExplicitAny: pass-through
				idempotency: (async (_c: unknown, next: () => Promise<void>) => next()) as any,
				burstRateLimiter: lowCapBurst,
				steadyRateLimiter: noopRateLimiter,
			}),
		)
		app.onError(onError)

		const r1 = await app.request('/api/public/widget/any-slug/booking', {
			method: 'POST',
			body: '{}',
			headers: { 'x-forwarded-for': '203.0.113.50', 'Content-Type': 'application/json' },
		})
		const r2 = await app.request('/api/public/widget/any-slug/booking', {
			method: 'POST',
			body: '{}',
			headers: { 'x-forwarded-for': '203.0.113.51', 'Content-Type': 'application/json' },
		})
		// Both clients pass — separate buckets, independent counters
		expect([200, 400, 404, 422]).toContain(r1.status)
		expect([200, 400, 404, 422]).toContain(r2.status)
	})

	test('[BCR17] Different slugs (same IP) do NOT share rate-limit bucket', async () => {
		const { makeTestRateLimiter, noopRateLimiter } = await import(
			'../../middleware/widget-rate-limit.ts'
		)
		const lowCapBurst = makeTestRateLimiter({ limit: 1, windowMs: 60_000 })
		const app = new Hono<AppEnv>().route(
			'/api/public/widget',
			createWidgetBookingCreateRoutes({
				// biome-ignore lint/suspicious/noExplicitAny: minimal stub
				service: { commit: () => Promise.resolve({}) } as any,
				// biome-ignore lint/suspicious/noExplicitAny: pass-through
				idempotency: (async (_c: unknown, next: () => Promise<void>) => next()) as any,
				burstRateLimiter: lowCapBurst,
				steadyRateLimiter: noopRateLimiter,
			}),
		)
		app.onError(onError)

		const headers = { 'x-forwarded-for': '203.0.113.60', 'Content-Type': 'application/json' }
		const r1 = await app.request('/api/public/widget/slug-one/booking', {
			method: 'POST',
			body: '{}',
			headers,
		})
		const r2 = await app.request('/api/public/widget/slug-two/booking', {
			method: 'POST',
			body: '{}',
			headers,
		})
		expect([200, 400, 404, 422]).toContain(r1.status)
		expect([200, 400, 404, 422]).toContain(r2.status)
	})
})
