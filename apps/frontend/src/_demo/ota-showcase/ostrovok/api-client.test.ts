/**
 * Round 9 — Островок demo API client strict tests.
 *
 * Canon: `feedback_round_9_demo_ota_server_canon_2026_05_25.md` +
 * `feedback_strict_tests.md` (exact-value, adversarial, error paths).
 *
 * Test matrix:
 *   ─── searchHotel ───────────────────────────────────────
 *     [S1] POST /search/hp/ — auth header + JSON body shape
 *     [S2] 200 → returns hotels[].rates[] verbatim
 *     [S3] error envelope → throws OstrovokApiError с error code
 *     [S4] HTTP 401 unauthorized → throws OstrovokApiError httpStatus=401
 *
 *   ─── prebookForm ───────────────────────────────────────
 *     [F1] POST /hotel/order/booking/form/ — body shape correct
 *     [F2] 200 → returns order_id + partner_order_id + payment_types
 *     [F3] invalid_partner_order_id error → throws с code
 *
 *   ─── finishBooking ─────────────────────────────────────
 *     [FB1] POST /hotel/order/booking/finish/ — body shape (partner.partner_order_id)
 *     [FB2] 200 → data is null (real ETG canon)
 *
 *   ─── pollFinishStatus ──────────────────────────────────
 *     [P1] POST /hotel/order/booking/finish/status/ — single field body
 *
 *   ─── cancelBooking ─────────────────────────────────────
 *     [C1] POST /hotel/order/cancel/ — body shape
 *     [C2] 200 → returns cancellation_state + amount_payable
 *
 *   ─── shared headers ────────────────────────────────────
 *     [H1] every call sends Authorization: Basic ZGVtbzpkZW1v
 *     [H2] every call sets Content-Type: application/json
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
	cancelBooking,
	finishBooking,
	OstrovokApiError,
	pollFinishStatus,
	prebookForm,
	SANDBOX_DEMO_HID,
	searchHotel,
} from './api-client.ts'

describe('Ostrovok API client', () => {
	let fetchSpy: ReturnType<typeof spyOn>

	beforeEach(() => {
		fetchSpy = spyOn(globalThis, 'fetch')
	})

	afterEach(() => {
		fetchSpy.mockRestore()
	})

	// ── searchHotel ────────────────────────────────────────────────

	describe('searchHotel', () => {
		test('[S1] POST /search/hp/ with auth + JSON body', async () => {
			fetchSpy.mockResolvedValue(
				new Response(
					JSON.stringify({
						status: 'ok',
						data: { hotels: [] },
						debug: null,
						error: null,
					}),
					{ status: 200 },
				),
			)
			await searchHotel({
				checkin: '2026-06-01',
				checkout: '2026-06-03',
				hid: SANDBOX_DEMO_HID,
				currency: 'RUB',
				language: 'ru',
				residency: 'ru',
				guests: [{ adults: 2, children: [] }],
			})
			expect(fetchSpy).toHaveBeenCalledTimes(1)
			const call = fetchSpy.mock.calls[0]
			expect(call?.[0]).toBe('/api/_mock-ota/ostrovok/v1/api/b2b/v3/search/hp/')
			const init = call?.[1] as RequestInit | undefined
			expect(init?.method).toBe('POST')
			const headers = init?.headers as Record<string, string>
			expect(headers.Authorization).toBe('Basic ZGVtbzpkZW1v')
			expect(headers['Content-Type']).toBe('application/json')
			const body = JSON.parse(init?.body as string) as Record<string, unknown>
			expect(body.checkin).toBe('2026-06-01')
			expect(body.checkout).toBe('2026-06-03')
			expect(body.hid).toBe(SANDBOX_DEMO_HID)
			expect(body.currency).toBe('RUB')
		})

		test('[S2] 200 returns hotels.rates verbatim', async () => {
			fetchSpy.mockResolvedValue(
				new Response(
					JSON.stringify({
						status: 'ok',
						data: {
							hotels: [
								{
									hid: SANDBOX_DEMO_HID,
									rates: [
										{
											book_hash: 'h-abc',
											daily_prices: [7000, 7000],
											meal_data: { value: 'nomeal', has_breakfast: false },
											room_name: 'Стандартный двухместный номер',
											total_price: 14000,
											currency_code: 'RUB',
										},
									],
								},
							],
						},
						debug: null,
						error: null,
					}),
					{ status: 200 },
				),
			)
			const res = await searchHotel({
				checkin: '2026-06-01',
				checkout: '2026-06-03',
				hid: SANDBOX_DEMO_HID,
				currency: 'RUB',
				language: 'ru',
				residency: 'ru',
				guests: [{ adults: 2, children: [] }],
			})
			expect(res.status).toBe('ok')
			expect(res.data.hotels.length).toBe(1)
			expect(res.data.hotels[0]?.rates[0]?.book_hash).toBe('h-abc')
			expect(res.data.hotels[0]?.rates[0]?.total_price).toBe(14000)
		})

		test('[S3] error envelope → throws OstrovokApiError', async () => {
			fetchSpy.mockResolvedValue(
				new Response(JSON.stringify({ status: 'error', error: 'invalid_date_range' }), {
					status: 400,
				}),
			)
			try {
				await searchHotel({
					checkin: 'bad',
					checkout: 'bad',
					hid: SANDBOX_DEMO_HID,
					currency: 'RUB',
					language: 'ru',
					residency: 'ru',
					guests: [{ adults: 1, children: [] }],
				})
				throw new Error('should have thrown')
			} catch (e) {
				expect(e).toBeInstanceOf(OstrovokApiError)
				expect((e as OstrovokApiError).code).toBe('invalid_date_range')
				expect((e as OstrovokApiError).httpStatus).toBe(400)
			}
		})

		test('[S4] 401 unauthorized → throws OstrovokApiError', async () => {
			fetchSpy.mockResolvedValue(
				new Response(JSON.stringify({ status: 'error', error: 'unauthorized' }), {
					status: 401,
				}),
			)
			try {
				await searchHotel({
					checkin: '2026-06-01',
					checkout: '2026-06-03',
					hid: SANDBOX_DEMO_HID,
					currency: 'RUB',
					language: 'ru',
					residency: 'ru',
					guests: [{ adults: 2, children: [] }],
				})
				throw new Error('should have thrown')
			} catch (e) {
				expect(e).toBeInstanceOf(OstrovokApiError)
				expect((e as OstrovokApiError).httpStatus).toBe(401)
			}
		})
	})

	// ── prebookForm ────────────────────────────────────────────────

	describe('prebookForm', () => {
		test('[F1] POST /hotel/order/booking/form/ body shape', async () => {
			fetchSpy.mockResolvedValue(
				new Response(
					JSON.stringify({
						status: 'ok',
						data: {
							order_id: 100,
							partner_order_id: '11111111-1111-4111-8111-111111111111',
							item_id: 200,
							payment_types: [
								{
									type: 'now',
									amount: '14000',
									currency_code: 'RUB',
									is_need_credit_card_data: true,
									is_need_cvc: true,
								},
							],
						},
						debug: null,
						error: null,
					}),
					{ status: 200 },
				),
			)
			await prebookForm({
				partner_order_id: '11111111-1111-4111-8111-111111111111',
				book_hash: 'h-abc',
				language: 'ru',
				user_ip: '127.0.0.1',
			})
			const call = fetchSpy.mock.calls[0]
			expect(call?.[0]).toBe('/api/_mock-ota/ostrovok/v1/api/b2b/v3/hotel/order/booking/form/')
			const init = call?.[1] as RequestInit | undefined
			const body = JSON.parse(init?.body as string) as Record<string, unknown>
			expect(body.partner_order_id).toBe('11111111-1111-4111-8111-111111111111')
			expect(body.book_hash).toBe('h-abc')
		})

		test('[F2] 200 returns order_id + partner_order_id + payment_types', async () => {
			fetchSpy.mockResolvedValue(
				new Response(
					JSON.stringify({
						status: 'ok',
						data: {
							order_id: 100,
							partner_order_id: 'p-1',
							item_id: 200,
							payment_types: [
								{
									type: 'now',
									amount: '14000',
									currency_code: 'RUB',
									is_need_credit_card_data: true,
									is_need_cvc: true,
								},
							],
						},
						debug: null,
						error: null,
					}),
					{ status: 200 },
				),
			)
			const res = await prebookForm({
				partner_order_id: 'p-1',
				book_hash: 'h-abc',
				language: 'ru',
				user_ip: '127.0.0.1',
			})
			expect(res.data.order_id).toBe(100)
			expect(res.data.partner_order_id).toBe('p-1')
			expect(res.data.payment_types[0]?.amount).toBe('14000')
		})

		test('[F3] invalid_partner_order_id error → throws', async () => {
			fetchSpy.mockResolvedValue(
				new Response(
					JSON.stringify({
						status: 'error',
						error: 'invalid_partner_order_id',
					}),
					{
						status: 400,
					},
				),
			)
			try {
				await prebookForm({
					partner_order_id: 'not-a-uuid',
					book_hash: 'h-abc',
					language: 'ru',
					user_ip: '127.0.0.1',
				})
				throw new Error('should have thrown')
			} catch (e) {
				expect(e).toBeInstanceOf(OstrovokApiError)
				expect((e as OstrovokApiError).code).toBe('invalid_partner_order_id')
			}
		})
	})

	// ── finishBooking ──────────────────────────────────────────────

	describe('finishBooking', () => {
		test('[FB1] POST /hotel/order/booking/finish/ body shape', async () => {
			fetchSpy.mockResolvedValue(
				new Response(
					JSON.stringify({
						status: 'ok',
						data: null,
						debug: null,
						error: null,
					}),
					{
						status: 200,
					},
				),
			)
			await finishBooking({
				partner: { partner_order_id: 'p-1' },
				user: { email: 'petr@example.com', phone: '+79999999998' },
				language: 'ru',
				rooms: [{ guests: [{ first_name: 'Пётр', last_name: 'Петров' }] }],
				payment_type: { type: 'now', amount: '14000', currency_code: 'RUB' },
			})
			const call = fetchSpy.mock.calls[0]
			expect(call?.[0]).toBe('/api/_mock-ota/ostrovok/v1/api/b2b/v3/hotel/order/booking/finish/')
			const init = call?.[1] as RequestInit | undefined
			const body = JSON.parse(init?.body as string) as Record<string, unknown>
			const partner = body.partner as Record<string, unknown>
			expect(partner.partner_order_id).toBe('p-1')
			const user = body.user as Record<string, unknown>
			expect(user.email).toBe('petr@example.com')
			expect(user.phone).toBe('+79999999998')
		})

		test('[FB2] 200 data is null (ETG canon)', async () => {
			fetchSpy.mockResolvedValue(
				new Response(
					JSON.stringify({
						status: 'ok',
						data: null,
						debug: null,
						error: null,
					}),
					{
						status: 200,
					},
				),
			)
			const res = await finishBooking({
				partner: { partner_order_id: 'p-1' },
				user: { email: 'p@example.com', phone: '+79999999998' },
				language: 'ru',
				rooms: [{ guests: [{ first_name: 'A', last_name: 'B' }] }],
				payment_type: { type: 'now', amount: '14000', currency_code: 'RUB' },
			})
			expect(res.status).toBe('ok')
			expect(res.data).toBeNull()
		})
	})

	// ── pollFinishStatus ───────────────────────────────────────────

	describe('pollFinishStatus', () => {
		test('[P1] POST /hotel/order/booking/finish/status/ — single field body', async () => {
			fetchSpy.mockResolvedValue(
				new Response(
					JSON.stringify({
						status: 'ok',
						data: null,
						debug: null,
						error: null,
					}),
					{
						status: 200,
					},
				),
			)
			await pollFinishStatus('p-1')
			const call = fetchSpy.mock.calls[0]
			expect(call?.[0]).toBe(
				'/api/_mock-ota/ostrovok/v1/api/b2b/v3/hotel/order/booking/finish/status/',
			)
			const init = call?.[1] as RequestInit | undefined
			const body = JSON.parse(init?.body as string) as Record<string, unknown>
			expect(body.partner_order_id).toBe('p-1')
		})
	})

	// ── cancelBooking ──────────────────────────────────────────────

	describe('cancelBooking', () => {
		test('[C1] POST /hotel/order/cancel/ body shape', async () => {
			fetchSpy.mockResolvedValue(
				new Response(
					JSON.stringify({
						status: 'ok',
						data: {
							amount_payable: { amount: '14000', currency_code: 'RUB' },
							amount_refunded: { amount: '14000', currency_code: 'RUB' },
							amount_sell: { amount: '14000', currency_code: 'RUB' },
							amount_info: { currency_code: 'RUB' },
							cancellation_state: 'cancelled',
						},
						debug: null,
						error: null,
					}),
					{ status: 200 },
				),
			)
			await cancelBooking('p-1')
			const call = fetchSpy.mock.calls[0]
			expect(call?.[0]).toBe('/api/_mock-ota/ostrovok/v1/api/b2b/v3/hotel/order/cancel/')
			const init = call?.[1] as RequestInit | undefined
			const body = JSON.parse(init?.body as string) as Record<string, unknown>
			expect(body.partner_order_id).toBe('p-1')
		})

		test('[C2] 200 returns cancellation_state + amount_payable', async () => {
			fetchSpy.mockResolvedValue(
				new Response(
					JSON.stringify({
						status: 'ok',
						data: {
							amount_payable: { amount: '14000', currency_code: 'RUB' },
							amount_refunded: { amount: '14000', currency_code: 'RUB' },
							amount_sell: { amount: '14000', currency_code: 'RUB' },
							amount_info: { currency_code: 'RUB' },
							cancellation_state: 'cancelled',
						},
						debug: null,
						error: null,
					}),
					{ status: 200 },
				),
			)
			const res = await cancelBooking('p-1')
			expect(res.data.cancellation_state).toBe('cancelled')
			expect(res.data.amount_payable.amount).toBe('14000')
		})
	})

	// ── shared headers ─────────────────────────────────────────────

	describe('shared headers', () => {
		test('[H1] every call sends Authorization: Basic ZGVtbzpkZW1v', async () => {
			fetchSpy.mockResolvedValue(
				new Response(
					JSON.stringify({
						status: 'ok',
						data: { hotels: [] },
						debug: null,
						error: null,
					}),
					{ status: 200 },
				),
			)
			await searchHotel({
				checkin: '2026-06-01',
				checkout: '2026-06-03',
				hid: SANDBOX_DEMO_HID,
				currency: 'RUB',
				language: 'ru',
				residency: 'ru',
				guests: [{ adults: 2, children: [] }],
			})
			const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined
			const headers = init?.headers as Record<string, string>
			expect(headers.Authorization).toBe('Basic ZGVtbzpkZW1v')
		})

		test('[H2] every call sets Content-Type: application/json', async () => {
			fetchSpy.mockResolvedValue(
				new Response(
					JSON.stringify({
						status: 'ok',
						data: null,
						debug: null,
						error: null,
					}),
					{
						status: 200,
					},
				),
			)
			await pollFinishStatus('p-1')
			const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined
			const headers = init?.headers as Record<string, string>
			expect(headers['Content-Type']).toBe('application/json')
		})

		test('[fetchImpl] custom fetchImpl injection works', async () => {
			const customFetch = spyOn(
				{
					fetch: () =>
						Promise.resolve(
							new Response(
								JSON.stringify({
									status: 'ok',
									data: { hotels: [] },
									debug: null,
									error: null,
								}),
								{ status: 200 },
							),
						),
				},
				'fetch',
			)
			await searchHotel(
				{
					checkin: '2026-06-01',
					checkout: '2026-06-03',
					hid: SANDBOX_DEMO_HID,
					currency: 'RUB',
					language: 'ru',
					residency: 'ru',
					guests: [{ adults: 2, children: [] }],
				},
				{ fetchImpl: customFetch as unknown as typeof fetch },
			)
			expect(customFetch).toHaveBeenCalledTimes(1)
			// Global fetch should NOT have been called (custom impl took over)
			expect(fetchSpy).toHaveBeenCalledTimes(0)
		})
	})
})
