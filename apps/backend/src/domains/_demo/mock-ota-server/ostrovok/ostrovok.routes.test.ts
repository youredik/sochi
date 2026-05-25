/**
 * Round 9 — Островок / ETG mock-OTA HTTP routes strict tests.
 *
 * Wraps the Round 8 production-grade ETG FSM canon с guest-facing HTTP
 * surface that mirrors the real ETG `api.worldota.net/api/b2b/v3/...` API
 * shape. Demo guest finishes booking → mock fires CloudEvents webhook back
 * to our own `/api/channel/webhooks/ETG` endpoint → reservation lands в PMS
 * inbox in ~2 seconds (wow-effect).
 *
 * Test IDs follow `[OSTR<n>]` numbering для cross-reference.
 *
 * Strict-tests canon (`feedback_strict_tests`):
 *   - Exact-value `.toBe(...)` / `.toEqual(...)` only.
 *   - No `.toBeDefined()` / `.toBeTruthy()` / `.toBeFalsy()`.
 *   - Adversarial cases (missing auth, bad book_hash, malformed UUID,
 *     expired form-stage, double-cancel idempotency).
 *
 * Mock layer compensations verified here:
 *   1. `status: 'completed'` (per real ETG canonical docs) — NOT `'confirmed'`
 *      as Round 8 mock emits at `ostrovok-etg-mock.ts:415`. We fix at the
 *      wrapper layer; Round 8 mock stays frozen.
 *   2. No retry-cap exposed at HTTP layer (Round 8 mock has 3-retry cap on
 *      `double_booking_form` collision; demo wow-effect doesn't model
 *      collisions so every finish succeeds без rotation).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { parseCloudEvent } from '../../../../lib/channel-manager/cloud-events.ts'
import { createOstrovokMockOtaRoutes } from './ostrovok.routes.ts'
import { __listBookHashes, __listBookings, __listFormStages, __resetState } from './state.ts'

const TEST_TENANT = 'org_demo_etg'
const TEST_PROPERTY = 'prop_demo_ostrovok'
const TEST_AUTH = `Basic ${Buffer.from('etg-key:etg-uuid', 'utf-8').toString('base64')}`
const SANDBOX_HID = 8473727

interface FetchCall {
	readonly url: string
	readonly init?: RequestInit | undefined
}

/**
 * Test-only fetch spy. Records each call (url + init) into a closure array
 * and returns a canned 200 response by default. The test that exercises
 * webhook receiver failure overrides the responder.
 */
function buildFetchSpy(opts: { respond?: (call: FetchCall) => Response | Promise<Response> } = {}) {
	const calls: FetchCall[] = []
	const spy = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		calls.push({ url, init })
		if (opts.respond) return opts.respond({ url, init })
		return new Response(
			JSON.stringify({
				accepted: true,
				eventId: 'mocked-evt-id',
				kid: 'kid_demo',
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		)
	}
	// `typeof fetch` includes `preconnect` (Bun's WHATWG fetch); test spy doesn't
	// need it — cast through `unknown` to satisfy strict TS without violating
	// any runtime contract (route handler only calls the function variant).
	const fetchImpl = spy as unknown as typeof fetch
	return { calls, fetchImpl }
}

/**
 * Lightweight log-warn spy — collected warnings asserted in OSTR9 (PII shield).
 */
function buildLogSpy() {
	const warnings: Array<{ msg: string; ctx: Record<string, unknown> }> = []
	return {
		warnings,
		logWarn: (msg: string, ctx: Record<string, unknown>) => {
			warnings.push({ msg, ctx })
		},
	}
}

function mountApp(
	deps: {
		fetchImpl?: typeof fetch
		logWarn?: (msg: string, ctx: Record<string, unknown>) => void
		nowMs?: () => number
	} = {},
) {
	const router = createOstrovokMockOtaRoutes({
		tenantId: TEST_TENANT,
		propertyId: TEST_PROPERTY,
		webhookTargetUrl: 'http://test.invalid/api/channel/webhooks/ETG',
		webhookSecret: 'whsec_demo_test_only',
		...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
		...(deps.logWarn !== undefined ? { logWarn: deps.logWarn } : {}),
		...(deps.nowMs !== undefined ? { nowMs: deps.nowMs } : {}),
	})
	return new Hono().route('/api/b2b/v3', router)
}

const SEARCH_BODY = {
	checkin: '2027-06-15',
	checkout: '2027-06-17', // 2 nights
	hid: SANDBOX_HID,
	currency: 'RUB' as const,
	language: 'ru' as const,
	residency: 'ru' as const,
	guests: [{ adults: 2, children: [] as ReadonlyArray<number> }],
}

/** RFC 4122 UUIDv4 fixed-form helper для test determinism. */
function uuidV4(): string {
	// Hand-built UUIDv4 (variant `8|9|a|b`, version `4`). Deterministic enough
	// when called inside a single test — randomBytes is fine.
	const r = (n: number): string => {
		const buf = new Uint8Array(n)
		crypto.getRandomValues(buf)
		return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
	}
	const hex = r(16)
	// Force version 4 + variant 8|9|a|b
	const versioned = `4${hex.slice(13, 16)}`
	const variantNibble = (Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8
	const variant = variantNibble.toString(16) + hex.slice(17, 20)
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${versioned}-${variant}-${hex.slice(20, 32)}`
}

async function postJson(
	app: Hono,
	path: string,
	body: unknown,
	opts: { authorization?: string | null } = {},
): Promise<{ status: number; json: unknown }> {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
	}
	if (opts.authorization === undefined) {
		headers.authorization = TEST_AUTH
	} else if (opts.authorization !== null) {
		headers.authorization = opts.authorization
	}
	const res = await app.request(path, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	})
	// Hono Response.json() returns any; treat as unknown and let каждый caller
	// narrow downstream via local interface cast. Avoids no-unsafe-assignment
	// rule while keeping the helper API ergonomic.
	const json = (await res.json()) as unknown
	return { status: res.status, json }
}

describe('Островок / ETG mock-OTA HTTP routes', () => {
	beforeEach(() => {
		__resetState()
	})
	afterEach(() => {
		__resetState()
	})

	// ── OSTR1 — Stage 1 happy path ─────────────────────────────────────────
	it('[OSTR1] POST /search/hp/ returns hotel with valid 32-hex book_hash', async () => {
		const app = mountApp()
		const { status, json } = await postJson(app, '/api/b2b/v3/search/hp/', SEARCH_BODY)
		expect(status).toBe(200)
		const body = json as {
			status: 'ok' | 'error'
			data: {
				hotels: ReadonlyArray<{
					hid: number
					rates: ReadonlyArray<{
						book_hash: string
						daily_prices: ReadonlyArray<number>
						room_name: string
						total_price: number
						currency_code: string
					}>
				}>
			}
		}
		expect(body.status).toBe('ok')
		expect(body.data.hotels.length).toBe(1)
		const hotel = body.data.hotels[0]
		if (hotel === undefined) throw new Error('hotel undefined')
		expect(hotel.hid).toBe(SANDBOX_HID)
		expect(hotel.rates.length).toBe(1)
		const rate = hotel.rates[0]
		if (rate === undefined) throw new Error('rate undefined')
		expect(rate.book_hash.length).toBe(32)
		expect(/^[0-9a-f]{32}$/.test(rate.book_hash)).toBe(true)
		expect(rate.daily_prices.length).toBe(2) // 2 nights
		expect(rate.currency_code).toBe('RUB')
		expect(rate.total_price).toBe(28000) // 2 nights × 7000 × 2 adults
		expect(__listBookHashes().length).toBe(1)
	})

	// ── OSTR2 — Stage 2 happy path ─────────────────────────────────────────
	it('[OSTR2] POST /form/ creates form-stage с valid book_hash + UUIDv4 partner_order_id', async () => {
		const app = mountApp()
		const search = await postJson(app, '/api/b2b/v3/search/hp/', SEARCH_BODY)
		const searchBody = search.json as {
			data: {
				hotels: ReadonlyArray<{ rates: ReadonlyArray<{ book_hash: string }> }>
			}
		}
		const bookHash = searchBody.data.hotels[0]?.rates[0]?.book_hash
		if (bookHash === undefined) throw new Error('book_hash missing in search')

		const partnerOrderId = uuidV4()
		const { status, json } = await postJson(app, '/api/b2b/v3/hotel/order/booking/form/', {
			partner_order_id: partnerOrderId,
			book_hash: bookHash,
			language: 'ru',
			user_ip: '127.0.0.1',
		})
		expect(status).toBe(200)
		const body = json as {
			status: 'ok'
			data: {
				order_id: number
				partner_order_id: string
				item_id: number
				payment_types: ReadonlyArray<{
					type: string
					amount: string
					currency_code: string
					is_need_credit_card_data: boolean
					is_need_cvc: boolean
				}>
			}
		}
		expect(body.status).toBe('ok')
		expect(body.data.partner_order_id).toBe(partnerOrderId)
		expect(typeof body.data.order_id).toBe('number')
		expect(body.data.order_id > 0).toBe(true)
		expect(typeof body.data.item_id).toBe('number')
		expect(body.data.payment_types.length).toBe(1)
		const pt = body.data.payment_types[0]
		if (pt === undefined) throw new Error('payment_types[0] undefined')
		expect(pt.type).toBe('now')
		expect(pt.amount).toBe('28000')
		expect(pt.currency_code).toBe('RUB')
		expect(pt.is_need_credit_card_data).toBe(true)
		expect(pt.is_need_cvc).toBe(true)
		expect(__listFormStages().length).toBe(1)
	})

	// ── OSTR3 — book_hash validation ───────────────────────────────────────
	it('[OSTR3] POST /form/ rejects unknown book_hash с 400 rate_not_found', async () => {
		const app = mountApp()
		const partnerOrderId = uuidV4()
		const { status, json } = await postJson(app, '/api/b2b/v3/hotel/order/booking/form/', {
			partner_order_id: partnerOrderId,
			book_hash: 'a'.repeat(32), // not stored
			language: 'ru',
			user_ip: '127.0.0.1',
		})
		expect(status).toBe(400)
		expect(json).toEqual({ status: 'error', error: 'rate_not_found' })
		expect(__listFormStages().length).toBe(0)
	})

	// ── OSTR4 — partner_order_id UUIDv4 validation ─────────────────────────
	it('[OSTR4] POST /form/ rejects malformed partner_order_id с 400 invalid_partner_order_id', async () => {
		const app = mountApp()
		// First create a valid book_hash so the failure is shape-only.
		await postJson(app, '/api/b2b/v3/search/hp/', SEARCH_BODY)
		const bookHashes = __listBookHashes()
		const bookHash = bookHashes[0]?.bookHash
		if (bookHash === undefined) throw new Error('book_hash missing in state')

		const { status, json } = await postJson(app, '/api/b2b/v3/hotel/order/booking/form/', {
			partner_order_id: 'NOT-A-UUID',
			book_hash: bookHash,
			language: 'ru',
			user_ip: '127.0.0.1',
		})
		expect(status).toBe(400)
		expect(json).toEqual({
			status: 'error',
			error: 'invalid_partner_order_id',
		})
	})

	// ── OSTR5 — form-stage 60-min lifetime ─────────────────────────────────
	it('[OSTR5] POST /finish/ rejects after 60+ min form-stage expiry с 400 order_not_found', async () => {
		const baseMs = Date.UTC(2027, 0, 1, 12, 0, 0) // fixed clock
		let currentMs = baseMs
		const app = mountApp({ nowMs: () => currentMs })

		const search = await postJson(app, '/api/b2b/v3/search/hp/', SEARCH_BODY)
		const bookHash = (
			search.json as {
				data: {
					hotels: ReadonlyArray<{
						rates: ReadonlyArray<{ book_hash: string }>
					}>
				}
			}
		).data.hotels[0]?.rates[0]?.book_hash
		if (bookHash === undefined) throw new Error('book_hash missing in search')

		const partnerOrderId = uuidV4()
		await postJson(app, '/api/b2b/v3/hotel/order/booking/form/', {
			partner_order_id: partnerOrderId,
			book_hash: bookHash,
			language: 'ru',
			user_ip: '127.0.0.1',
		})
		expect(__listFormStages().length).toBe(1)

		// Advance clock 61 minutes — form-stage now expired.
		currentMs = baseMs + 61 * 60 * 1000

		const finish = await postJson(app, '/api/b2b/v3/hotel/order/booking/finish/', {
			partner: { partner_order_id: partnerOrderId },
			user: { email: 'guest@example.com', phone: '+70001234567' },
			language: 'ru',
			rooms: [{ guests: [{ first_name: 'Иван', last_name: 'Иванов' }] }],
			payment_type: { type: 'now', amount: '28000', currency_code: 'RUB' },
		})
		expect(finish.status).toBe(400)
		expect(finish.json).toEqual({ status: 'error', error: 'order_not_found' })
		expect(__listBookings().length).toBe(0)
	})

	// ── OSTR6 — Stage 3 happy path + webhook emission ──────────────────────
	it('[OSTR6] POST /finish/ marks booking confirmed + fires CloudEvents webhook с status=completed', async () => {
		const { fetchImpl, calls } = buildFetchSpy()
		const app = mountApp({ fetchImpl })

		const search = await postJson(app, '/api/b2b/v3/search/hp/', SEARCH_BODY)
		const bookHash = (
			search.json as {
				data: {
					hotels: ReadonlyArray<{
						rates: ReadonlyArray<{ book_hash: string }>
					}>
				}
			}
		).data.hotels[0]?.rates[0]?.book_hash
		if (bookHash === undefined) throw new Error('book_hash missing in search')

		const partnerOrderId = uuidV4()
		const form = await postJson(app, '/api/b2b/v3/hotel/order/booking/form/', {
			partner_order_id: partnerOrderId,
			book_hash: bookHash,
			language: 'ru',
			user_ip: '127.0.0.1',
		})
		const formBody = form.json as {
			data: { order_id: number; item_id: number }
		}
		const orderId = formBody.data.order_id

		const finish = await postJson(app, '/api/b2b/v3/hotel/order/booking/finish/', {
			partner: { partner_order_id: partnerOrderId },
			user: { email: 'guest@example.com', phone: '+70001234567' },
			language: 'ru',
			rooms: [
				{
					guests: [
						{ first_name: 'Иван', last_name: 'Иванов', is_child: false },
						{ first_name: 'Мария', last_name: 'Иванова', is_child: false },
					],
				},
			],
			payment_type: { type: 'now', amount: '28000', currency_code: 'RUB' },
		})
		expect(finish.status).toBe(200)
		expect(finish.json).toEqual({
			status: 'ok',
			data: null,
			debug: null,
			error: null,
		})

		// Booking persisted; form-stage consumed.
		expect(__listBookings().length).toBe(1)
		expect(__listFormStages().length).toBe(0)
		const booking = __listBookings()[0]
		if (booking === undefined) throw new Error('booking undefined')
		expect(booking.partnerOrderId).toBe(partnerOrderId)
		expect(booking.status).toBe('confirmed')
		expect(booking.guests.length).toBe(2)

		// Webhook fired exactly once with canonical signed envelope.
		expect(calls.length).toBe(1)
		const call = calls[0]
		if (call === undefined) throw new Error('call undefined')
		expect(call.url).toBe('http://test.invalid/api/channel/webhooks/ETG')
		const headers = call.init?.headers as Record<string, string> | undefined
		if (headers === undefined) throw new Error('headers undefined')
		expect(headers['content-type']).toBe('application/json')
		const whId = headers['webhook-id']
		expect(typeof whId).toBe('string')
		expect((whId ?? '').length > 0).toBe(true)
		expect(typeof headers['webhook-timestamp']).toBe('string')
		expect(headers['webhook-signature']?.startsWith('v1,')).toBe(true)

		// CloudEvents envelope validation.
		const rawBody = call.init?.body
		if (typeof rawBody !== 'string') throw new Error('rawBody not string')
		const parsed = parseCloudEvent(JSON.parse(rawBody))
		if (parsed === null) throw new Error('parsed envelope null')
		expect(parsed.specversion).toBe('1.0')
		expect(parsed.type).toBe('app.sochi.channel.booking.created.v1')
		expect(parsed.source).toBe(`urn:sochi:channel:ETG:tenant:${TEST_TENANT}`)
		expect(parsed.subject).toBe(String(orderId))

		// Round 8 bug compensation: status MUST be 'completed' (canonical ETG
		// terminal state per real docs), NOT 'confirmed' (Round 8 mock bug).
		const data = parsed.data as {
			status: string
			partner_order_id: string
			channel_id: string
		}
		expect(data.status).toBe('completed')
		expect(data.partner_order_id).toBe(partnerOrderId)
		expect(data.channel_id).toBe('ETG')
	})

	// ── OSTR7 — Stage 4 status polling ─────────────────────────────────────
	it('[OSTR7] POST /finish/status/ returns ok for finalized booking', async () => {
		const { fetchImpl } = buildFetchSpy()
		const app = mountApp({ fetchImpl })

		const search = await postJson(app, '/api/b2b/v3/search/hp/', SEARCH_BODY)
		const bookHash = (
			search.json as {
				data: {
					hotels: ReadonlyArray<{
						rates: ReadonlyArray<{ book_hash: string }>
					}>
				}
			}
		).data.hotels[0]?.rates[0]?.book_hash
		if (bookHash === undefined) throw new Error('book_hash missing in search')

		const partnerOrderId = uuidV4()
		await postJson(app, '/api/b2b/v3/hotel/order/booking/form/', {
			partner_order_id: partnerOrderId,
			book_hash: bookHash,
			language: 'ru',
			user_ip: '127.0.0.1',
		})
		await postJson(app, '/api/b2b/v3/hotel/order/booking/finish/', {
			partner: { partner_order_id: partnerOrderId },
			user: { email: 'guest@example.com', phone: '+70001234567' },
			language: 'ru',
			rooms: [{ guests: [{ first_name: 'Иван', last_name: 'Иванов' }] }],
			payment_type: { type: 'now', amount: '28000', currency_code: 'RUB' },
		})

		const { status, json } = await postJson(app, '/api/b2b/v3/hotel/order/booking/finish/status/', {
			partner_order_id: partnerOrderId,
		})
		expect(status).toBe(200)
		expect(json).toEqual({
			status: 'ok',
			data: null,
			debug: null,
			error: null,
		})
	})

	// ── OSTR8 — Stage 5 cancel + webhook ───────────────────────────────────
	it('[OSTR8] POST /cancel/ returns refund shape + fires cancelled webhook с status=completed', async () => {
		const { fetchImpl, calls } = buildFetchSpy()
		const app = mountApp({ fetchImpl })

		const search = await postJson(app, '/api/b2b/v3/search/hp/', SEARCH_BODY)
		const bookHash = (
			search.json as {
				data: {
					hotels: ReadonlyArray<{
						rates: ReadonlyArray<{ book_hash: string }>
					}>
				}
			}
		).data.hotels[0]?.rates[0]?.book_hash
		if (bookHash === undefined) throw new Error('book_hash missing in search')

		const partnerOrderId = uuidV4()
		await postJson(app, '/api/b2b/v3/hotel/order/booking/form/', {
			partner_order_id: partnerOrderId,
			book_hash: bookHash,
			language: 'ru',
			user_ip: '127.0.0.1',
		})
		await postJson(app, '/api/b2b/v3/hotel/order/booking/finish/', {
			partner: { partner_order_id: partnerOrderId },
			user: { email: 'guest@example.com', phone: '+70001234567' },
			language: 'ru',
			rooms: [{ guests: [{ first_name: 'Иван', last_name: 'Иванов' }] }],
			payment_type: { type: 'now', amount: '28000', currency_code: 'RUB' },
		})
		expect(calls.length).toBe(1) // created webhook

		const cancel = await postJson(app, '/api/b2b/v3/hotel/order/cancel/', {
			partner_order_id: partnerOrderId,
		})
		expect(cancel.status).toBe(200)
		const body = cancel.json as {
			status: 'ok'
			data: {
				amount_payable: { amount: string; currency_code: string }
				amount_refunded: { amount: string; currency_code: string }
				amount_sell: { amount: string; currency_code: string }
				amount_info: { currency_code: string }
				cancellation_state: string
			}
		}
		expect(body.status).toBe('ok')
		expect(body.data.amount_payable.amount).toBe('28000')
		expect(body.data.amount_payable.currency_code).toBe('RUB')
		expect(body.data.amount_refunded.amount).toBe('28000')
		expect(body.data.amount_sell.amount).toBe('28000')
		expect(body.data.amount_info.currency_code).toBe('RUB')
		expect(body.data.cancellation_state).toBe('cancelled')

		// Cancel webhook fired (call #2).
		expect(calls.length).toBe(2)
		const cancelCall = calls[1]
		if (cancelCall === undefined) throw new Error('cancelCall undefined')
		const rawBody = cancelCall.init?.body
		if (typeof rawBody !== 'string') throw new Error('rawBody not string')
		const parsed = parseCloudEvent(JSON.parse(rawBody))
		if (parsed === null) throw new Error('parsed envelope null')
		expect(parsed.type).toBe('app.sochi.channel.booking.cancelled.v1')
		const data = parsed.data as { status: string; channel_id: string }
		expect(data.status).toBe('completed') // Round 8 bug compensation
		expect(data.channel_id).toBe('ETG')

		// Booking state mutation persisted.
		const stored = __listBookings()[0]
		if (stored === undefined) throw new Error('stored undefined')
		expect(stored.status).toBe('cancelled')
	})

	// ── OSTR9 — Double-cancel idempotency ──────────────────────────────────
	it('[OSTR9] Double-cancel: second call returns already_cancelled с NO additional webhook', async () => {
		const { fetchImpl, calls } = buildFetchSpy()
		const app = mountApp({ fetchImpl })

		const search = await postJson(app, '/api/b2b/v3/search/hp/', SEARCH_BODY)
		const bookHash = (
			search.json as {
				data: {
					hotels: ReadonlyArray<{
						rates: ReadonlyArray<{ book_hash: string }>
					}>
				}
			}
		).data.hotels[0]?.rates[0]?.book_hash
		if (bookHash === undefined) throw new Error('book_hash missing in search')

		const partnerOrderId = uuidV4()
		await postJson(app, '/api/b2b/v3/hotel/order/booking/form/', {
			partner_order_id: partnerOrderId,
			book_hash: bookHash,
			language: 'ru',
			user_ip: '127.0.0.1',
		})
		await postJson(app, '/api/b2b/v3/hotel/order/booking/finish/', {
			partner: { partner_order_id: partnerOrderId },
			user: { email: 'guest@example.com', phone: '+70001234567' },
			language: 'ru',
			rooms: [{ guests: [{ first_name: 'Иван', last_name: 'Иванов' }] }],
			payment_type: { type: 'now', amount: '28000', currency_code: 'RUB' },
		})

		// First cancel — cancelled + webhook.
		const first = await postJson(app, '/api/b2b/v3/hotel/order/cancel/', {
			partner_order_id: partnerOrderId,
		})
		expect(first.status).toBe(200)
		const firstBody = first.json as { data: { cancellation_state: string } }
		expect(firstBody.data.cancellation_state).toBe('cancelled')
		expect(calls.length).toBe(2) // created + first-cancel

		// Second cancel — already_cancelled status, NO duplicate webhook.
		const second = await postJson(app, '/api/b2b/v3/hotel/order/cancel/', {
			partner_order_id: partnerOrderId,
		})
		expect(second.status).toBe(200)
		const secondBody = second.json as { data: { cancellation_state: string } }
		expect(secondBody.data.cancellation_state).toBe('already_cancelled')
		expect(calls.length).toBe(2) // no new webhook
	})

	// ── OSTR10 — Auth (mock-lenient) ───────────────────────────────────────
	it('[OSTR10] Missing Authorization → 401 unauthorized', async () => {
		const app = mountApp()
		const { status, json } = await postJson(app, '/api/b2b/v3/search/hp/', SEARCH_BODY, {
			authorization: null,
		})
		expect(status).toBe(401)
		expect(json).toEqual({ status: 'error', error: 'unauthorized' })
	})

	it('[OSTR10.b] Empty Authorization → 401 unauthorized', async () => {
		const app = mountApp()
		const { status, json } = await postJson(app, '/api/b2b/v3/search/hp/', SEARCH_BODY, {
			authorization: '',
		})
		expect(status).toBe(401)
		expect(json).toEqual({ status: 'error', error: 'unauthorized' })
	})

	it('[OSTR10.c] Non-Basic Authorization → 401 unauthorized', async () => {
		const app = mountApp()
		const { status, json } = await postJson(app, '/api/b2b/v3/search/hp/', SEARCH_BODY, {
			authorization: 'Bearer not-basic',
		})
		expect(status).toBe(401)
		expect(json).toEqual({ status: 'error', error: 'unauthorized' })
	})

	it('[OSTR10.d] Any non-empty Basic Authorization → accepted (mock-lenient)', async () => {
		const app = mountApp()
		const { status } = await postJson(app, '/api/b2b/v3/search/hp/', SEARCH_BODY, {
			authorization: `Basic ${Buffer.from('anything:goes', 'utf-8').toString('base64')}`,
		})
		expect(status).toBe(200)
	})

	// ── OSTR11 — Reserved-test shield: Round 10 P0-3 = HARD REJECT (152-ФЗ) ─
	it('[OSTR11] Non-reserved guest email → HTTP 422 + warn (Round 10 P0-3 hard reject)', async () => {
		const { fetchImpl, calls } = buildFetchSpy()
		const log = buildLogSpy()
		const app = mountApp({ fetchImpl, logWarn: log.logWarn })

		const search = await postJson(app, '/api/b2b/v3/search/hp/', SEARCH_BODY)
		const bookHash = (
			search.json as {
				data: {
					hotels: ReadonlyArray<{
						rates: ReadonlyArray<{ book_hash: string }>
					}>
				}
			}
		).data.hotels[0]?.rates[0]?.book_hash
		if (bookHash === undefined) throw new Error('book_hash missing in search')

		const partnerOrderId = uuidV4()
		await postJson(app, '/api/b2b/v3/hotel/order/booking/form/', {
			partner_order_id: partnerOrderId,
			book_hash: bookHash,
			language: 'ru',
			user_ip: '127.0.0.1',
		})
		const finish = await postJson(app, '/api/b2b/v3/hotel/order/booking/finish/', {
			partner: { partner_order_id: partnerOrderId },
			user: { email: 'realguest@gmail.com', phone: '+79161234567' }, // NOT reserved
			language: 'ru',
			rooms: [{ guests: [{ first_name: 'Иван', last_name: 'Иванов' }] }],
			payment_type: { type: 'now', amount: '28000', currency_code: 'RUB' },
		})
		// Round 10 P0-3: HARD REJECT — real PII не должна попасть в demo flow
		// (152-ФЗ legal cover canon). Email checked first → reject before phone seen.
		expect(finish.status).toBe(422)
		expect((finish.json as { error: string }).error).toBe('non_reserved_demo_data')
		expect((finish.json as { field: string }).field).toBe('email')
		// Webhook MUST NOT fire on reject (no PII leak downstream).
		expect(calls.length).toBe(0)
		// First check tripped → 1 warn (not 2, because second never runs).
		expect(log.warnings.length).toBe(1)
		expect(log.warnings[0]?.msg).toBe('guest_email_rejected_not_reserved_test')
	})

	it('[OSTR11.b] Reserved-test guest contact details → NO warn log', async () => {
		const { fetchImpl } = buildFetchSpy()
		const log = buildLogSpy()
		const app = mountApp({ fetchImpl, logWarn: log.logWarn })

		const search = await postJson(app, '/api/b2b/v3/search/hp/', SEARCH_BODY)
		const bookHash = (
			search.json as {
				data: {
					hotels: ReadonlyArray<{
						rates: ReadonlyArray<{ book_hash: string }>
					}>
				}
			}
		).data.hotels[0]?.rates[0]?.book_hash
		if (bookHash === undefined) throw new Error('book_hash missing in search')

		const partnerOrderId = uuidV4()
		await postJson(app, '/api/b2b/v3/hotel/order/booking/form/', {
			partner_order_id: partnerOrderId,
			book_hash: bookHash,
			language: 'ru',
			user_ip: '127.0.0.1',
		})
		await postJson(app, '/api/b2b/v3/hotel/order/booking/finish/', {
			partner: { partner_order_id: partnerOrderId },
			// `+7 000` is the Россвязь reserved RU block; `*.example.com` per RFC 2606.
			user: { email: 'ivan@example.com', phone: '+70001234567' },
			language: 'ru',
			rooms: [{ guests: [{ first_name: 'Иван', last_name: 'Иванов' }] }],
			payment_type: { type: 'now', amount: '28000', currency_code: 'RUB' },
		})
		expect(log.warnings.length).toBe(0)
	})

	// ── OSTR12 — Search hid mismatch ───────────────────────────────────────
	it('[OSTR12] POST /search/hp/ с non-sandbox hid → empty hotels array', async () => {
		const app = mountApp()
		const { status, json } = await postJson(app, '/api/b2b/v3/search/hp/', {
			...SEARCH_BODY,
			hid: 1234, // not sandbox demo hid
		})
		expect(status).toBe(200)
		const body = json as { data: { hotels: ReadonlyArray<unknown> } }
		expect(body.data.hotels).toEqual([])
		expect(__listBookHashes().length).toBe(0)
	})

	// ── OSTR13 — Cancel non-existent → 404 ─────────────────────────────────
	it('[OSTR13] POST /cancel/ unknown partner_order_id → 404 order_not_found, no webhook', async () => {
		const { fetchImpl, calls } = buildFetchSpy()
		const app = mountApp({ fetchImpl })
		const { status, json } = await postJson(app, '/api/b2b/v3/hotel/order/cancel/', {
			partner_order_id: uuidV4(),
		})
		expect(status).toBe(404)
		expect(json).toEqual({ status: 'error', error: 'order_not_found' })
		expect(calls.length).toBe(0)
	})

	// ── OSTR14 — Finish without form-stage ─────────────────────────────────
	it('[OSTR14] POST /finish/ unknown partner_order_id → 400 order_not_found', async () => {
		const { fetchImpl, calls } = buildFetchSpy()
		const app = mountApp({ fetchImpl })
		const { status, json } = await postJson(app, '/api/b2b/v3/hotel/order/booking/finish/', {
			partner: { partner_order_id: uuidV4() },
			user: { email: 'guest@example.com', phone: '+70001234567' },
			language: 'ru',
			rooms: [{ guests: [{ first_name: 'Иван', last_name: 'Иванов' }] }],
			payment_type: { type: 'now', amount: '28000', currency_code: 'RUB' },
		})
		expect(status).toBe(400)
		expect(json).toEqual({ status: 'error', error: 'order_not_found' })
		expect(calls.length).toBe(0)
	})

	// ── OSTR15 — book_hash 24h lifetime ────────────────────────────────────
	it('[OSTR15] book_hash expires after 24h+ → 400 rate_not_found', async () => {
		const baseMs = Date.UTC(2027, 0, 1, 12, 0, 0)
		let currentMs = baseMs
		const app = mountApp({ nowMs: () => currentMs })

		const search = await postJson(app, '/api/b2b/v3/search/hp/', SEARCH_BODY)
		const bookHash = (
			search.json as {
				data: {
					hotels: ReadonlyArray<{
						rates: ReadonlyArray<{ book_hash: string }>
					}>
				}
			}
		).data.hotels[0]?.rates[0]?.book_hash
		if (bookHash === undefined) throw new Error('book_hash missing in search')

		// Advance clock 25 hours.
		currentMs = baseMs + 25 * 60 * 60 * 1000

		const form = await postJson(app, '/api/b2b/v3/hotel/order/booking/form/', {
			partner_order_id: uuidV4(),
			book_hash: bookHash,
			language: 'ru',
			user_ip: '127.0.0.1',
		})
		expect(form.status).toBe(400)
		expect(form.json).toEqual({ status: 'error', error: 'rate_not_found' })
	})
})
