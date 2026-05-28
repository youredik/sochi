/**
 * Round 9 — Островок / ETG mock-OTA HTTP routes (`/api/b2b/v3/*`).
 *
 * Mirrors the real ETG B2B API surface at `api.worldota.net/api/b2b/v3/...`
 * с поведением канонически согласованным с Round 8 `OstrovokEtgMock` FSM
 * (search → prebook → book → start → check), но реализованным inline в
 * `_demo/`. Cross-domain import `channel/ostrovok-etg/` would trip
 * `no-cross-domain` rule in `.dependency-cruiser.mjs` — we mirror the
 * behaviour shape, не reach across the boundary.
 *
 * Five endpoints (real ETG paths verbatim):
 *
 *   - `POST /search/hp/` — hotel-page search (stage 1)
 *   - `POST /hotel/order/booking/form/` — prebook (stage 2)
 *   - `POST /hotel/order/booking/finish/` — finalize + fire webhook (stage 3)
 *   - `POST /hotel/order/booking/finish/status/` — status polling (stage 4)
 *   - `POST /hotel/order/cancel/` — cancel + fire webhook (stage 5)
 *
 * **Auth (mock-lenient)**: real ETG = HTTP Basic `KEY_ID:API_KEY`. Mock
 * accepts ANY non-empty `Authorization: Basic ...`. Missing → 401
 * `{ status: 'error', error: 'unauthorized' }`. We do NOT verify the
 * credentials beyond the prefix — это demo, не sandbox.
 *
 * **Webhook emission**:
 *   1. Per-call к `emitDemoWebhook` fires a Standard-Webhooks-signed
 *      CloudEvents 1.0.2 envelope POST к `<base>/api/channel/webhooks/ETG`
 *      so the production-tested webhook receiver lands the inbox row.
 *   2. The CloudEvents `data.status` carries `"completed"` (real ETG canonical
 *      terminal-state per их docs) — this is our wrapper-layer compensation
 *      for the Round 8 mock bug (`ostrovok-etg-mock.ts:415` accepts only
 *      `'confirmed'` / `'failed'`, but per ETG production docs the terminal
 *      string is `'completed'`). Round 8 mock is frozen; we patch at the
 *      wrapper layer.
 *   3. Additionally we relax the partner_order_id rotation cap (Round 8 mock
 *      enforces 3-retry cap inside book SM, but demo wow-effect doesn't model
 *      double-booking collisions — every finish succeeds without rotation).
 *
 * **Reserved-test shield**: guest email / phone are passed to
 * `isReservedTestDomain` / `isReservedTestPhone`. Non-reserved values get a
 * warning log so demo operators notice if a real person typed real PII into
 * the demo form. We do NOT block on it — demo accepts everything but logs.
 *
 * **State**: in-memory `state.ts` (Phase-1). Lazy TTL on `book_hash` (24h) +
 * `form_stage` (60min). Phase-2 migrates to YDB `mockOtaReservation_demo`
 * table с native 24h TTL.
 */

import { Hono } from 'hono'
import type { AppEnv } from '../../../../factory.ts'
import { resolveDemoPropertyId } from '../../../../lib/demo-channel-seed.ts'
import {
	isReservedTestDomain,
	isReservedTestPhone,
} from '../../../../workers/lib/reserved-test-ranges.ts'
import { emitDemoWebhook } from '../shared/webhook-emit.ts'
import { generateBookHash, generateItemId, generateOrderId, type OstrovokStore } from './store.ts'

/**
 * Canonical sandbox demo hotel id mirrors the Round 8 ETG canon
 * (`SANDBOX_DEMO_HID = 8473727`). Any other hid in `search/hp/` returns
 * empty data — demo wow-effect runs against one fixed property.
 */
const SANDBOX_DEMO_HID = 8473727

/**
 * Per-night price in RUB minor (kopeck) units — chosen so a 2-night demo
 * booking lands ровно 14 000 ₽ total. The Round 8 mock uses 7 000 000 micros
 * (= 7 RUB per smallest unit), but в HTTP-shape ETG returns RUB-units
 * directly. We surface 7 000 (₽) per night here.
 */
const NIGHTLY_PRICE_RUB = 7000

const DEFAULT_ROOM_NAME = 'Стандартный двухместный номер'
const DEFAULT_MEAL_NAME = 'Без питания'

/**
 * UUIDv4 regex (per RFC 4122 §4.4). ETG requires `partner_order_id` matches
 * a UUIDv4 shape — мы reject malformed ids с 400 `invalid_partner_order_id`.
 *
 * Length constraint (3-256 chars) comes from real ETG B2B docs, but а UUIDv4
 * canonical form is fixed 36 chars; we trust the regex to handle both.
 */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Compute the night count between two YYYY-MM-DD dates. Rejects invalid
 * ordering (checkout <= checkin) by returning 0 — callers treat that as a
 * search-validation failure.
 */
function nightsBetween(checkin: string, checkout: string): number {
	const a = new Date(`${checkin}T00:00:00Z`).getTime()
	const b = new Date(`${checkout}T00:00:00Z`).getTime()
	if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
	const diff = Math.round((b - a) / (24 * 60 * 60 * 1000))
	return diff > 0 ? diff : 0
}

/**
 * Build the per-night price array (constant pricing for demo wow-effect —
 * real ETG returns variable seasonal pricing). Length === night count.
 */
function buildDailyPrices(nights: number): ReadonlyArray<number> {
	const prices: number[] = []
	for (let i = 0; i < nights; i++) prices.push(NIGHTLY_PRICE_RUB)
	return prices
}

/**
 * Real ETG error envelope shape: `{ status: 'error', error: '<code>' }`.
 * We mirror exactly so demo frontend can pattern-match against real-ETG
 * canonical error codes (`rate_not_found`, `unauthorized`, ...).
 */
function errorEnvelope(code: string): {
	readonly status: 'error'
	readonly error: string
} {
	return { status: 'error', error: code }
}

export interface OstrovokMockOtaDeps {
	/**
	 * Round 14.6 — tenantId derived per-request from `c.var.tenantId`
	 * (`tenantMiddleware`). Not injected here. Multi-tenant by design.
	 *
	 * Round 14.6.4 — `propertyId` field DROPPED: was mount-time constant
	 * causing silent identity drift с per-tenant `channelConnection`.
	 * Routes now derive propertyId via `resolveDemoPropertyId(tenantId)`.
	 */
	/**
	 * Store (multi-tenant; tenantId per-method). Single shared instance.
	 */
	readonly store: OstrovokStore
	/**
	 * Target URL for the webhook emission. Phase-1 default is the local backend
	 * (`http://localhost:8787/api/channel/webhooks/ETG`); tests override to
	 * the spy fetch base.
	 */
	readonly webhookTargetUrl: string
	/**
	 * Standard-Webhooks signing secret — MUST match the `webhookSecret` row
	 * for channel ETG в DB (or the override в `DEMO_MOCK_OTA_WEBHOOK_SECRET`
	 * env). Phase-1 default = `whsec_demo_test_only` для local dev.
	 */
	readonly webhookSecret: string
	/** Test fetch injector. Defaults to `globalThis.fetch`. */
	readonly fetchImpl?: typeof fetch
	/** Clock injector для test determinism. Defaults to `Date.now`. */
	readonly nowMs?: () => number
	/**
	 * Logger sink — defaults to `console.warn`. Used для reserved-test-shield
	 * warnings on non-reserved guest contact details.
	 */
	readonly logWarn?: (msg: string, ctx: Record<string, unknown>) => void
}

/**
 * Build the Hono router for Островок / ETG mock-OTA endpoints. Composed onto
 * `/api/_mock-ota/ostrovok/v1` (Batch-3 wiring); tests mount onto a fresh
 * `Hono()` at `/v1`.
 */
export function createOstrovokMockOtaRoutes(deps: OstrovokMockOtaDeps): Hono<AppEnv> {
	const app = new Hono<AppEnv>()
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch
	const nowMs = deps.nowMs ?? (() => Date.now())
	const logWarn =
		deps.logWarn ??
		((msg: string, ctx: Record<string, unknown>) => {
			console.warn(`[mock-ota.ostrovok] ${msg}`, ctx)
		})

	/**
	 * Lenient Basic-Auth shield. Rejects ONLY если header missing / empty /
	 * doesn't start с literal `Basic `. Does NOT decode or validate credentials.
	 * Mirrors the mock-lenient canon from the user spec.
	 */
	function checkAuth(c: { req: { header: (name: string) => string | undefined } }): boolean {
		const auth = c.req.header('authorization')
		if (auth === undefined || auth.length === 0) return false
		if (!auth.startsWith('Basic ')) return false
		// Anything after `Basic ` non-empty counts — we accept any encoded payload.
		return auth.length > 'Basic '.length
	}

	/**
	 * Shield log: warn if guest contact details are NOT в reserved-test ranges.
	 * Does NOT block — demo accepts everything. Only purpose: surface real-PII
	 * leak risk if env is misconfigured (e.g. ENABLE_DEMO_MODE=true in prod).
	 */
	/**
	 * Round 10 P0-3 — reserved-test-range shield = HARD REJECT, не warn.
	 * Canon `feedback_round_10_truthful_post_review_canon_2026_05_25.md` +
	 * `feedback_post_flip_5expert_verification_canon_2026_05_24.md`.
	 * Returns null = pass; returns field name = caller emits 422.
	 */
	function rejectNonReservedContact(email: string, phone: string): 'email' | 'phone' | null {
		if (!isReservedTestDomain(email)) {
			logWarn('guest_email_rejected_not_reserved_test', { email })
			return 'email'
		}
		if (!isReservedTestPhone(phone)) {
			logWarn('guest_phone_rejected_not_reserved_test', { phone })
			return 'phone'
		}
		return null
	}

	// ── Stage 1: POST /search/hp/ ──────────────────────────────────────────
	app.post('/search/hp/', async (c) => {
		if (!checkAuth(c)) return c.json(errorEnvelope('unauthorized'), 401)
		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json(errorEnvelope('malformed_json'), 400)
		}
		const parsed = body as {
			checkin?: unknown
			checkout?: unknown
			hid?: unknown
			currency?: unknown
			language?: unknown
			residency?: unknown
			guests?: unknown
		}
		const checkin = typeof parsed.checkin === 'string' ? parsed.checkin : ''
		const checkout = typeof parsed.checkout === 'string' ? parsed.checkout : ''
		const hid = typeof parsed.hid === 'number' ? parsed.hid : Number.NaN
		if (checkin === '' || checkout === '' || !Number.isFinite(hid)) {
			return c.json(errorEnvelope('invalid_payload'), 400)
		}
		const nights = nightsBetween(checkin, checkout)
		if (nights === 0) {
			return c.json(errorEnvelope('invalid_date_range'), 400)
		}
		// Demo wow-effect: only the sandbox demo hid returns offers.
		if (hid !== SANDBOX_DEMO_HID) {
			return c.json({
				data: { hotels: [] },
				status: 'ok' as const,
				debug: null,
				error: null,
			})
		}
		const guestsArr = Array.isArray(parsed.guests) ? parsed.guests : []
		const firstGuest = guestsArr[0] as { adults?: unknown; children?: unknown } | undefined
		const adults =
			firstGuest !== undefined && typeof firstGuest.adults === 'number' && firstGuest.adults > 0
				? firstGuest.adults
				: 2
		const childrenRaw =
			firstGuest !== undefined && Array.isArray(firstGuest.children) ? firstGuest.children : []
		const children: ReadonlyArray<number> = childrenRaw.filter(
			(age): age is number => typeof age === 'number' && age >= 0,
		)

		const bookHash = generateBookHash()
		const dailyPrices = buildDailyPrices(nights)
		const totalPrice = dailyPrices.reduce((acc, p) => acc + p, 0) * adults
		await deps.store.storeBookHash(c.var.tenantId, {
			bookHash,
			hid,
			checkin,
			checkout,
			adults,
			children,
			currency: 'RUB',
			dailyPrices,
			totalPrice,
			roomName: DEFAULT_ROOM_NAME,
			mealName: DEFAULT_MEAL_NAME,
			nowMs: nowMs(),
		})

		return c.json({
			status: 'ok' as const,
			data: {
				hotels: [
					{
						hid,
						rates: [
							{
								book_hash: bookHash,
								daily_prices: dailyPrices,
								meal_data: { value: 'nomeal', has_breakfast: false },
								room_name: DEFAULT_ROOM_NAME,
								total_price: totalPrice,
								currency_code: 'RUB',
							},
						],
					},
				],
			},
			debug: null,
			error: null,
		})
	})

	// ── Stage 2: POST /hotel/order/booking/form/ ───────────────────────────
	app.post('/hotel/order/booking/form/', async (c) => {
		if (!checkAuth(c)) return c.json(errorEnvelope('unauthorized'), 401)
		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json(errorEnvelope('malformed_json'), 400)
		}
		const parsed = body as {
			partner_order_id?: unknown
			book_hash?: unknown
			language?: unknown
			user_ip?: unknown
		}
		const partnerOrderId =
			typeof parsed.partner_order_id === 'string' ? parsed.partner_order_id : ''
		const bookHash = typeof parsed.book_hash === 'string' ? parsed.book_hash : ''

		// ETG canonical contract: 3-256 char string в UUIDv4 shape.
		if (
			partnerOrderId.length < 3 ||
			partnerOrderId.length > 256 ||
			!UUID_V4_REGEX.test(partnerOrderId)
		) {
			return c.json(errorEnvelope('invalid_partner_order_id'), 400)
		}
		if (bookHash.length === 0) {
			return c.json(errorEnvelope('invalid_payload'), 400)
		}

		const bookHashContext = await deps.store.getBookHash(c.var.tenantId, bookHash, nowMs())
		if (bookHashContext === null) {
			return c.json(errorEnvelope('rate_not_found'), 400)
		}

		// If a form-stage already exists for the same partner_order_id, return
		// it idempotently rather than re-creating — matches real ETG behaviour
		// when client retries the same prebook call.
		const existing = await deps.store.getFormStage(c.var.tenantId, partnerOrderId, nowMs())
		const orderId = existing !== null ? existing.orderId : generateOrderId()
		const itemId = existing !== null ? existing.itemId : generateItemId()
		if (existing === null) {
			await deps.store.storeFormStage(c.var.tenantId, {
				partnerOrderId,
				bookHash,
				orderId,
				itemId,
				currency: 'RUB',
				totalAmount: bookHashContext.totalPrice,
				nowMs: nowMs(),
			})
		}

		return c.json({
			status: 'ok' as const,
			data: {
				order_id: orderId,
				partner_order_id: partnerOrderId,
				item_id: itemId,
				payment_types: [
					{
						type: 'now' as const,
						amount: String(bookHashContext.totalPrice),
						currency_code: 'RUB',
						is_need_credit_card_data: true,
						is_need_cvc: true,
					},
				],
			},
			debug: null,
			error: null,
		})
	})

	// ── Stage 3: POST /hotel/order/booking/finish/ ─────────────────────────
	app.post('/hotel/order/booking/finish/', async (c) => {
		if (!checkAuth(c)) return c.json(errorEnvelope('unauthorized'), 401)
		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json(errorEnvelope('malformed_json'), 400)
		}
		const parsed = body as {
			partner?: { partner_order_id?: unknown }
			user?: { email?: unknown; phone?: unknown }
			language?: unknown
			rooms?: unknown
			payment_type?: unknown
		}
		const partnerOrderId =
			typeof parsed.partner?.partner_order_id === 'string' ? parsed.partner.partner_order_id : ''
		const email = typeof parsed.user?.email === 'string' ? parsed.user.email : ''
		const phone = typeof parsed.user?.phone === 'string' ? parsed.user.phone : ''

		if (partnerOrderId === '' || email === '' || phone === '') {
			return c.json(errorEnvelope('invalid_payload'), 400)
		}

		const form = await deps.store.getFormStage(c.var.tenantId, partnerOrderId, nowMs())
		if (form === null) {
			return c.json(errorEnvelope('order_not_found'), 400)
		}

		const bookHashContext = await deps.store.getBookHash(c.var.tenantId, form.bookHash, nowMs())
		if (bookHashContext === null) {
			// Edge case: book_hash expired between form-stage creation и finish.
			return c.json(errorEnvelope('rate_not_found'), 400)
		}

		// Round 10 P0-3 — hard reject non-reserved PII (152-ФЗ legal-cover).
		const shieldField = rejectNonReservedContact(email, phone)
		if (shieldField !== null) {
			return c.json(
				{
					status: 'error',
					error: 'non_reserved_demo_data',
					field: shieldField,
					data: null,
				},
				422,
			)
		}

		// Parse rooms[0].guests shape (real ETG repeats per-room; demo squashes).
		const roomsArr = Array.isArray(parsed.rooms) ? parsed.rooms : []
		const firstRoom = roomsArr[0] as { guests?: unknown } | undefined
		const guestsArr =
			firstRoom !== undefined && Array.isArray(firstRoom.guests) ? firstRoom.guests : []
		const guests = guestsArr
			.map((g: unknown) => {
				const guest = g as {
					first_name?: unknown
					last_name?: unknown
					is_child?: unknown
					age?: unknown
				}
				const firstName = typeof guest.first_name === 'string' ? guest.first_name : ''
				const lastName = typeof guest.last_name === 'string' ? guest.last_name : ''
				if (firstName === '' || lastName === '') return null
				const isChild = guest.is_child === true
				const age = typeof guest.age === 'number' ? guest.age : undefined
				return {
					firstName,
					lastName,
					isChild,
					...(age !== undefined ? { age } : {}),
				}
			})
			.filter((g): g is NonNullable<typeof g> => g !== null)

		const booking = await deps.store.finalizeBooking(c.var.tenantId, {
			form,
			bookHashContext,
			customerEmail: email,
			customerPhone: phone,
			guests,
			nowMs: nowMs(),
		})

		// Webhook emission — wrapper-layer compensation for Round 8 mock's
		// `status='confirmed'` bug: emit `status='completed'` per real ETG
		// canonical terminal-state string. Includes the full booking payload
		// в `data` so the channel inbox row carries enough context for the
		// PMS split-pane to render без an extra fetch.
		await emitDemoWebhook({
			channelId: 'ETG',
			tenantId: c.var.tenantId,
			externalReservationId: String(booking.orderId),
			action: 'created',
			data: {
				partner_order_id: booking.partnerOrderId,
				order_id: booking.orderId,
				item_id: booking.itemId,
				status: 'completed' as const, // Round 8 bug compensation
				hid: booking.hid,
				checkin: booking.checkin,
				checkout: booking.checkout,
				currency_code: booking.currency,
				total_amount: booking.totalAmount,
				customer_email: booking.customerEmail,
				customer_phone: booking.customerPhone,
				guests: booking.guests,
				channel_id: 'ETG' as const,
				// Round 14.6.4 — per-tenant propertyId (was: deps.propertyId
				// mount-time constant breaking per-tenant identity).
				property_id: resolveDemoPropertyId(c.var.tenantId),
			},
			targetUrlOverride: deps.webhookTargetUrl,
			secretOverride: deps.webhookSecret,
			fetchImpl,
			nowMs,
		})

		return c.json({
			status: 'ok' as const,
			data: null,
			debug: null,
			error: null,
		})
	})

	// ── Stage 4: POST /hotel/order/booking/finish/status/ ──────────────────
	app.post('/hotel/order/booking/finish/status/', async (c) => {
		if (!checkAuth(c)) return c.json(errorEnvelope('unauthorized'), 401)
		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json(errorEnvelope('malformed_json'), 400)
		}
		const parsed = body as { partner_order_id?: unknown }
		const partnerOrderId =
			typeof parsed.partner_order_id === 'string' ? parsed.partner_order_id : ''
		if (partnerOrderId === '') {
			return c.json(errorEnvelope('invalid_payload'), 400)
		}
		// Demo simplification: always return 'ok' immediately if the booking exists
		// (real ETG может вернуть 'processing' first, then 'ok' on subsequent poll).
		const booking = await deps.store.getBooking(c.var.tenantId, partnerOrderId)
		if (booking === null) {
			return c.json(errorEnvelope('order_not_found'), 404)
		}
		return c.json({
			status: 'ok' as const,
			data: null,
			debug: null,
			error: null,
		})
	})

	// ── Stage 5: POST /hotel/order/cancel/ ──────────────────────────────────
	app.post('/hotel/order/cancel/', async (c) => {
		if (!checkAuth(c)) return c.json(errorEnvelope('unauthorized'), 401)
		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json(errorEnvelope('malformed_json'), 400)
		}
		const parsed = body as { partner_order_id?: unknown }
		const partnerOrderId =
			typeof parsed.partner_order_id === 'string' ? parsed.partner_order_id : ''
		if (partnerOrderId === '') {
			return c.json(errorEnvelope('invalid_payload'), 400)
		}
		const result = await deps.store.cancelBooking(c.var.tenantId, partnerOrderId)
		if (result === 'not_found') {
			return c.json(errorEnvelope('order_not_found'), 404)
		}
		const booking = await deps.store.getBooking(c.var.tenantId, partnerOrderId)
		if (booking === null) {
			// Defensive: cancelBooking returned a non-not_found status, so booking
			// MUST exist — unreachable in practice but typescript narrows safer.
			return c.json(errorEnvelope('internal_error'), 500)
		}

		// Idempotent cancel: only fire webhook on the first transition. Second
		// cancel returns same shape (amount-payable etc.) but no duplicate inbox row.
		if (result === 'cancelled') {
			await emitDemoWebhook({
				channelId: 'ETG',
				tenantId: c.var.tenantId,
				externalReservationId: String(booking.orderId),
				action: 'cancelled',
				data: {
					partner_order_id: booking.partnerOrderId,
					order_id: booking.orderId,
					item_id: booking.itemId,
					status: 'completed' as const, // wrapper layer canonical terminal string
					hid: booking.hid,
					currency_code: booking.currency,
					total_amount: booking.totalAmount,
					channel_id: 'ETG' as const,
					// Round 14.6.4 — per-tenant propertyId (was: deps.propertyId
					// mount-time constant breaking per-tenant identity).
					property_id: resolveDemoPropertyId(c.var.tenantId),
				},
				targetUrlOverride: deps.webhookTargetUrl,
				secretOverride: deps.webhookSecret,
				fetchImpl,
				nowMs,
			})
		}

		return c.json({
			status: 'ok' as const,
			data: {
				amount_payable: {
					amount: String(booking.totalAmount),
					currency_code: 'RUB' as const,
				},
				amount_refunded: {
					amount: String(booking.totalAmount),
					currency_code: 'RUB' as const,
				},
				amount_sell: {
					amount: String(booking.totalAmount),
					currency_code: 'RUB' as const,
				},
				amount_info: {
					currency_code: 'RUB' as const,
				},
				cancellation_state: result, // 'cancelled' | 'already_cancelled'
			},
			debug: null,
			error: null,
		})
	})

	return app
}
