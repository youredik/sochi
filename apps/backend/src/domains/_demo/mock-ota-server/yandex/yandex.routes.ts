/**
 * Yandex.Путешествия mock-OTA HTTP routes — Round 9 demo wow-effect.
 *
 * Thin HTTP wrapper around the Round 8 production-grade
 * `createYandexTravelMock()` adapter. Mirrors the real
 * `whitelabel.travel.yandex-net.ru` API surface so demo guests interact с
 * a façade that "looks like Yandex" — the wrap fires a CloudEvents-signed
 * webhook back to our own backend на каждом mutation, closing the demo
 * loop.
 *
 * Routes (mounted under `/api/_mock-ota/yandex/v1`):
 *   - `GET  /hotels/hotel/offers`                       — search availability
 *   - `POST /hotels/booking/orders`                     — create order
 *   - `POST /hotels/booking/orders/:order_id/payment/cancel` — cancel order
 *
 * Authentication shape: real Yandex.Путешествия requires `Authorization:
 * OAuth <token>`. Mock accepts **any non-empty** Authorization header (it's
 * a demo — issuing real OAuth would distract from wow-effect). Missing or
 * empty header → 401.
 *
 * Reserved-test-range shield: guest email/phone are checked against the
 * RFC 2606 / RFC 6761 / ITU-T E.164.3 reserved ranges. Mock accepts both
 * reserved (default demo fixtures) and non-reserved (real-ish demo data),
 * but logs a warning for the latter so prod operators noticing the warn
 * know the demo path was used for non-demo data.
 *
 * Webhook delivery: synchronous `await` on the fetch — the route handler
 * does NOT return 200 to the OTA guest until the webhook lands. This
 * guarantees the PMS split-pane already shows the reservation by the time
 * the success page renders.
 *
 * Out-of-scope (per Round 9 Phase-1 canon):
 *   - Multi-property catalog (single demo hotel id)
 *   - Real promo codes / loyalty
 *   - Real payment integration (status='CONFIRMED' immediately)
 *   - English UI / mobile-responsive (server is API-only — UI lives в `apps/frontend/src/_demo/`)
 *
 * Canon: `feedback_round_9_demo_ota_server_canon_2026_05_25.md`.
 */

import { Hono } from 'hono'
import type { AppEnv } from '../../../../factory.ts'
import { resolveDemoPropertyId } from '../../../../lib/demo-channel-seed.ts'
import { logger } from '../../../../logger.ts'
import {
	isReservedTestDomain,
	isReservedTestPhone,
} from '../../../../workers/lib/reserved-test-ranges.ts'
import { createYandexTravelMock } from '../../../channel/yandex-travel/yandex-travel-mock.ts'
import { emitDemoWebhook } from '../shared/webhook-emit.ts'
import { generateBookingToken, generateOrderId, type YandexStore } from './store.ts'

// 1 RUB = 1_000_000 micros (Google Ads / Stripe canon). For demo wow we want
// realistic numbers (~6000 RUB/night), so 6_000_000_000n micros = 6000 RUB.
const DEMO_NIGHT_RATE_MICROS = 6_000_000_000n // 6000 RUB / night

const DEMO_ROOM_NAME = 'Стандартный номер с видом на горы'

export interface YandexMockOtaRoutesOptions {
	/**
	 * Round 14.6 — tenantId derived per-request via `c.var.tenantId`
	 * (`tenantMiddleware`). Not injected here.
	 *
	 * Round 14.6.4 — `propertyId` removed: was mount-time constant (=
	 * `'demo-hotel-sochi'`) causing per-tenant `channelConnection` row
	 * keyed by `demoprop_<orgId>` to NEVER match the mock-adapter's
	 * internal reservation state. propertyId теперь derived per-call
	 * via `resolveDemoPropertyId(c.var.tenantId)` — single source of
	 * truth lives в `lib/demo-channel-seed.ts`.
	 */
	/**
	 * Store (multi-tenant; tenantId per-method). Single shared instance.
	 */
	readonly store: YandexStore
	/** Override webhook target URL — typically `http://localhost:8787/api/channel/webhooks/YT`. */
	readonly webhookTargetUrl?: string
	/** Override webhook signing secret (matches `webhookSecret` table for YT channel). */
	readonly webhookSecret?: string
	/** Inject fetch implementation для tests — defaults to `globalThis.fetch`. */
	readonly fetchImpl?: typeof fetch
	/** Inject clock для deterministic timestamps в tests. */
	readonly nowMs?: () => number
}

/**
 * Compute nightly prices for a date range. Returns ONE price per night
 * (count = nights). Mock simply repeats `nightlyRubMicros` for now — Phase 2
 * will pull from `mockOtaInventoryPool_demo` YDB table.
 *
 * Returns prices in **whole rubles** (not micros) for direct embedding в
 * the offer response — real Yandex returns rubles, not micros.
 */
export function computeDailyPrices(input: {
	checkinDate: string
	checkoutDate: string
	nightlyRubMicros: bigint
}): ReadonlyArray<number> {
	const inMs = Date.parse(input.checkinDate)
	const outMs = Date.parse(input.checkoutDate)
	const nights = Math.max(1, Math.round((outMs - inMs) / 86_400_000))
	const rubPerNight = Number(input.nightlyRubMicros / 1_000_000n)
	return Array.from({ length: nights }, () => rubPerNight)
}

/**
 * Lenient auth check: Authorization header present + non-empty.
 * Real Yandex demands `OAuth <token>` shape — mock relaxes that requirement.
 */
function requireAuth(authHeader: string | undefined): { ok: true } | { ok: false } {
	if (authHeader === undefined || authHeader.length === 0) return { ok: false }
	return { ok: true }
}

/**
 * Validate date range: both ISO YYYY-MM-DD, checkin strictly less than checkout.
 */
function validateDateRange(checkin: string | undefined, checkout: string | undefined): boolean {
	if (typeof checkin !== 'string' || typeof checkout !== 'string') return false
	if (checkin.length === 0 || checkout.length === 0) return false
	const inMs = Date.parse(checkin)
	const outMs = Date.parse(checkout)
	if (!Number.isFinite(inMs) || !Number.isFinite(outMs)) return false
	return inMs < outMs
}

export function createYandexMockOtaRoutes(opts: YandexMockOtaRoutesOptions): Hono<AppEnv> {
	const app = new Hono<AppEnv>()

	// Round 14.6 — per-tenant mockAdapter cache. Each tenant gets own FSM
	// + HMAC + sequence machinery; lazy-instantiated on first request.
	// Round 14.6.4 — propertyId derived per-tenant via `resolveDemoPropertyId`
	// (was mount-time constant, breaking per-tenant identity).
	//
	// **Concurrency invariant** (Round 14.6.4 follow-up defensive fix):
	// Cache stores `Promise<Adapter>` (not bare adapter). Lazy-init wraps
	// the factory call в IIFE — Promise stored synchronously inside the
	// `get`/`set` boundary, so concurrent requests for the same tenantId
	// receive the SAME Promise instance regardless of whether the factory
	// becomes async later. Adds one microtask k-each-call cost (negligible
	// vs HTTP roundtrip + YDB write) but eliminates ANY race possibility
	// — including hypothetical future `async createYandexTravelMock`.
	// Canonical 2026 lazy-init memoization pattern (web research 28.05.2026).
	// Regression-pinned by [YTR-CONCURRENT] test asserting 50 parallel
	// `Promise.all` calls share the same adapter state.
	const mockAdapterCache = new Map<string, Promise<ReturnType<typeof createYandexTravelMock>>>()
	function getMockAdapter(tenantId: string): Promise<ReturnType<typeof createYandexTravelMock>> {
		const cached = mockAdapterCache.get(tenantId)
		if (cached !== undefined) return cached
		const fresh = (async () =>
			createYandexTravelMock({
				tenantId,
				propertyId: resolveDemoPropertyId(tenantId),
				nightRateMicros: DEMO_NIGHT_RATE_MICROS,
			}))()
		mockAdapterCache.set(tenantId, fresh)
		return fresh
	}

	/**
	 * Route 1 — search availability.
	 *
	 * Real Yandex shape:
	 *   GET /hotels/hotel/offers?hotelId=...&checkinDate=...&checkoutDate=...
	 *                          &adults=...&children=...
	 * Response:
	 *   { offers: [{ booking_token, room_name, daily_prices, total_price,
	 *                currency, can_send_comment_to_hotel }] }
	 */
	app.get('/hotels/hotel/offers', async (c) => {
		const auth = requireAuth(c.req.header('authorization'))
		if (!auth.ok) return c.json({ error: 'unauthorized' }, 401)

		// Round 14.6.4 follow-up — derive hotelId per-tenant from authenticated
		// session. Pre-fix: frontend's hardcoded `DEFAULT_HOTEL_ID='demo-hotel-
		// sochi'` flowed through the query param, leaked в webhook data, and
		// returned the SAME hotel_id для every tenant. Per-tenant `c.var.tenantId`
		// derivation is the canonical 2026 pattern (web research 28.05.2026 —
		// «never trust per-tenant identifiers from request body/query»).
		// Query.hotelId retained for backward-compat (legacy callers + Round 9
		// smoke tests pass it explicitly), but tenant-derived value always
		// wins. Validates query.hotelId is non-empty к preserve missing-param
		// 400 contract.
		const queryHotelId = c.req.query('hotelId') ?? ''
		if (queryHotelId.length === 0) {
			return c.json({ error: 'missing_hotel_id' }, 400)
		}
		const hotelId = resolveDemoPropertyId(c.var.tenantId)
		const checkinDate = c.req.query('checkinDate')
		const checkoutDate = c.req.query('checkoutDate')
		const adults = Number.parseInt(c.req.query('adults') ?? '0', 10)
		const children = Number.parseInt(c.req.query('children') ?? '0', 10)
		if (!validateDateRange(checkinDate, checkoutDate)) {
			return c.json({ error: 'invalid_date_range' }, 400)
		}
		if (!Number.isFinite(adults) || adults < 1) {
			return c.json({ error: 'invalid_party_size' }, 400)
		}
		// At this point checkinDate / checkoutDate are validated non-null.
		const checkin = checkinDate as string
		const checkout = checkoutDate as string

		const dailyPrices = computeDailyPrices({
			checkinDate: checkin,
			checkoutDate: checkout,
			nightlyRubMicros: DEMO_NIGHT_RATE_MICROS,
		})
		const totalPrice = dailyPrices.reduce((s, p) => s + p, 0)

		const token = generateBookingToken()
		await opts.store.storeBookingToken(c.var.tenantId, {
			token,
			hotelId,
			checkinDate: checkin,
			checkoutDate: checkout,
			adults,
			children: Number.isFinite(children) ? children : 0,
			totalPriceMicros: DEMO_NIGHT_RATE_MICROS * BigInt(dailyPrices.length),
			...(opts.nowMs !== undefined ? { nowMs: opts.nowMs() } : {}),
		})

		return c.json(
			{
				offers: [
					{
						booking_token: token,
						room_name: DEMO_ROOM_NAME,
						daily_prices: dailyPrices,
						total_price: totalPrice,
						currency: 'RUB',
						can_send_comment_to_hotel: true,
					},
				],
			},
			200,
		)
	})

	/**
	 * Route 2 — create order.
	 *
	 * Body:
	 *   { booking_token, customer_email, customer_phone,
	 *     guests: [{ first_name, last_name, is_child?, age? }],
	 *     comment?, promo_codes? }
	 *
	 * Pipeline:
	 *   1. Auth check.
	 *   2. Consume booking_token (single-use; rejects expired/missing).
	 *   3. Reserved-test-range shield: log warning for non-reserved guest data
	 *      (defense-in-depth — prevents accidental real upstream side effects
	 *      if route is mounted в a production-flagged env).
	 *   4. Call `mockAdapter.verifyBooking` + `mockAdapter.createBooking` to
	 *      get an externalId. We use this as the canonical reservation id —
	 *      `order_id` is independent (yt-order-XXX) but `data.external_id`
	 *      carries the internal one so PMS can correlate.
	 *   5. Fire `app.sochi.channel.booking.created.v1` CloudEvents webhook к
	 *      our own backend's channel inbox.
	 *   6. Wait for webhook ack BEFORE responding (closes demo loop).
	 *   7. Return `{ order_id, status: 'CONFIRMED' }`.
	 */
	app.post('/hotels/booking/orders', async (c) => {
		const auth = requireAuth(c.req.header('authorization'))
		if (!auth.ok) return c.json({ error: 'unauthorized' }, 401)

		let body: {
			booking_token?: string
			customer_email?: string
			customer_phone?: string
			guests?: ReadonlyArray<{
				first_name?: string
				last_name?: string
				is_child?: boolean
				age?: number
			}>
			comment?: string
			promo_codes?: ReadonlyArray<string>
		}
		try {
			body = (await c.req.json()) as typeof body
		} catch {
			return c.json({ error: 'malformed_json' }, 400)
		}

		const token = body.booking_token ?? ''
		if (token.length === 0) {
			return c.json({ error: 'missing_booking_token' }, 400)
		}
		const tokenCtx = await opts.store.consumeBookingToken(c.var.tenantId, token, opts.nowMs?.())
		if (tokenCtx === null) {
			return c.json({ error: 'invalid_booking_token' }, 400)
		}

		const customerEmail = body.customer_email ?? ''
		const customerPhone = body.customer_phone ?? ''
		const guests = Array.isArray(body.guests) ? body.guests : []
		if (customerEmail.length === 0 || customerPhone.length === 0 || guests.length === 0) {
			return c.json({ error: 'missing_required_guest_fields' }, 400)
		}
		const primaryGuest = guests[0]
		if (
			primaryGuest === undefined ||
			typeof primaryGuest.first_name !== 'string' ||
			typeof primaryGuest.last_name !== 'string' ||
			primaryGuest.first_name.length === 0 ||
			primaryGuest.last_name.length === 0
		) {
			return c.json({ error: 'missing_primary_guest_name' }, 400)
		}

		// Round 10 P0-3 fix — reserved-test-range shield = HARD REJECT, не warn.
		// Canon `feedback_round_10_truthful_post_review_canon_2026_05_25.md` +
		// `feedback_post_flip_5expert_verification_canon_2026_05_24.md` (демо
		// accepting real PII без legal cover = ст.5 ч.2 152-ФЗ до 700k₽ КоАП).
		// До Round 10: warn-only — реальный email/phone мог утечь в guest snapshot
		// → channel inbox → real upstream на A7.5 dispatch.
		if (!isReservedTestDomain(customerEmail)) {
			logger.warn(
				{
					channelId: 'YT',
					emailDomainSuffix: customerEmail.split('@').pop() ?? '',
				},
				'mock_ota_yandex_rejected_non_reserved_email',
			)
			return c.json({ error: 'non_reserved_demo_data', field: 'customer_email' }, 422)
		}
		if (!isReservedTestPhone(customerPhone)) {
			logger.warn({ channelId: 'YT' }, 'mock_ota_yandex_rejected_non_reserved_phone')
			return c.json({ error: 'non_reserved_demo_data', field: 'customer_phone' }, 422)
		}

		// Step 4 — verify + create через production-grade Round 8 adapter.
		// Round 14.6.4 — propertyId per-tenant via resolveDemoPropertyId.
		const mockAdapter = await getMockAdapter(c.var.tenantId)
		const verifyResult = await mockAdapter.verifyBooking({
			tenantId: c.var.tenantId,
			propertyId: resolveDemoPropertyId(c.var.tenantId),
			roomTypeId: 'yt_rt',
			ratePlanId: 'yt_rp',
			checkIn: tokenCtx.checkinDate,
			checkOut: tokenCtx.checkoutDate,
			guestCount: guests.length,
			guest: {
				firstName: primaryGuest.first_name,
				lastName: primaryGuest.last_name,
				email: customerEmail,
				phone: customerPhone,
			},
		})
		const idempotencyKey = `demo-${token}-${Date.now()}`
		const { externalId } = await mockAdapter.createBooking({
			verifyResult,
			idempotencyKey,
		})

		// Step 5 — persist order locally + fire CloudEvents webhook.
		const orderId = generateOrderId()
		await opts.store.storeOrder(c.var.tenantId, {
			orderId,
			bookingToken: token,
			customerEmail,
			customerPhone,
			status: 'CONFIRMED',
			externalReservationId: externalId,
			createdAtMs: opts.nowMs?.() ?? Date.now(),
			guests: guests.map((g) => ({
				firstName: g.first_name ?? '',
				lastName: g.last_name ?? '',
				isChild: g.is_child === true,
				...(typeof g.age === 'number' ? { age: g.age } : {}),
			})),
		})

		const webhookResult = await emitDemoWebhook({
			channelId: 'YT',
			tenantId: c.var.tenantId,
			externalReservationId: orderId,
			action: 'created',
			...(opts.webhookTargetUrl !== undefined ? { targetUrlOverride: opts.webhookTargetUrl } : {}),
			...(opts.webhookSecret !== undefined ? { secretOverride: opts.webhookSecret } : {}),
			...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
			...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
			data: {
				order_id: orderId,
				external_id: externalId,
				channel_id: 'YT',
				hotel_id: tokenCtx.hotelId,
				check_in: tokenCtx.checkinDate,
				check_out: tokenCtx.checkoutDate,
				adults: tokenCtx.adults,
				children: tokenCtx.children,
				guests: guests.map((g) => ({
					first_name: g.first_name,
					last_name: g.last_name,
					is_child: g.is_child === true,
					...(typeof g.age === 'number' ? { age: g.age } : {}),
				})),
				customer_email: customerEmail,
				customer_phone: customerPhone,
				...(typeof body.comment === 'string' ? { comment: body.comment } : {}),
				total_price_rub: Number(tokenCtx.totalPriceMicros / 1_000_000n),
				currency: 'RUB',
			},
		})

		if (!webhookResult.ok) {
			logger.warn(
				{
					channelId: 'YT',
					orderId,
					httpStatus: webhookResult.httpStatus,
					webhookError: webhookResult.error,
				},
				'mock_ota_yandex_webhook_delivery_failed',
			)
		}

		return c.json({ order_id: orderId, status: 'CONFIRMED' }, 200)
	})

	/**
	 * Route 3 — cancel order.
	 *
	 * Real Yandex shape: POST /hotels/booking/orders/{order_id}/payment/cancel
	 * Returns: { order_id, status: 'CANCELLED' | 'already_cancelled' }
	 * Errors: 404 if order_id unknown.
	 */
	app.post('/hotels/booking/orders/:order_id/payment/cancel', async (c) => {
		const auth = requireAuth(c.req.header('authorization'))
		if (!auth.ok) return c.json({ error: 'unauthorized' }, 401)

		const orderId = c.req.param('order_id')
		const order = await opts.store.getOrder(c.var.tenantId, orderId)
		if (order === null) {
			return c.json({ error: 'order_not_found' }, 404)
		}

		const cancelStatus = await opts.store.cancelOrder(c.var.tenantId, orderId)
		if (cancelStatus === 'not_found') {
			// Lost a race с another cancel? Treat as not_found.
			return c.json({ error: 'order_not_found' }, 404)
		}
		if (cancelStatus === 'already_cancelled') {
			// Idempotent — return status but DON'T re-fire webhook.
			return c.json({ order_id: orderId, status: 'already_cancelled' }, 200)
		}

		// First successful cancel — propagate к Round 8 adapter (so its FSM also
		// transitions) и fire CloudEvents webhook.
		const idempotencyKey = `demo-cancel-${orderId}`
		const mockAdapter = await getMockAdapter(c.var.tenantId)
		await mockAdapter.cancelReservation({
			tenantId: c.var.tenantId,
			externalId: order.externalReservationId,
			idempotencyKey,
		})

		const webhookResult = await emitDemoWebhook({
			channelId: 'YT',
			tenantId: c.var.tenantId,
			externalReservationId: orderId,
			action: 'cancelled',
			...(opts.webhookTargetUrl !== undefined ? { targetUrlOverride: opts.webhookTargetUrl } : {}),
			...(opts.webhookSecret !== undefined ? { secretOverride: opts.webhookSecret } : {}),
			...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
			...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
			data: {
				order_id: orderId,
				external_id: order.externalReservationId,
				channel_id: 'YT',
				cancelled_at: new Date(opts.nowMs?.() ?? Date.now()).toISOString(),
			},
		})

		if (!webhookResult.ok) {
			logger.warn(
				{
					channelId: 'YT',
					orderId,
					httpStatus: webhookResult.httpStatus,
					webhookError: webhookResult.error,
				},
				'mock_ota_yandex_cancel_webhook_delivery_failed',
			)
		}

		return c.json({ order_id: orderId, status: 'CANCELLED' }, 200)
	})

	return app
}
