/**
 * Ostrovok ETG API contract tests — ETG-CONTRACT1-6 (M10 / A7.4 / D15 + D7-D10).
 *
 * Verifies canonical wire shapes для ETG b2b/v3 endpoints:
 *   - CONTRACT1: HTTP Basic Auth header construction
 *   - CONTRACT2: /search/v1/hotelpage response
 *   - CONTRACT3: /book/v1/order/booking/finish prebook response
 *   - CONTRACT4: /book/v2/booking/finish book response
 *   - CONTRACT5: /book/v2/booking/info status check response (terminal)
 *   - CONTRACT6: webhook envelope (terminal-only)
 *
 * Lib canon: msw@2.14.3 + zod@4.4.3.
 */

import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

const ETG_BASE = 'https://api-sandbox.worldota.net/api/b2b/v3'

// =============================================================================
// CANONICAL ETG WIRE SHAPES
// =============================================================================

const etgSearchResponseSchema = z.object({
	status: z.literal('ok'),
	data: z.object({
		hid: z.number().int(),
		searchId: z.string(),
		hotels: z.array(
			z.object({
				priceMicros: z.string().regex(/^\d+$/),
				currency: z.literal('RUB'),
				cancellationPolicy: z.object({
					referencePoint: z.literal('GuestArrivalTime'),
					hoursBeforeRef: z.number().int().nonnegative(),
					penaltyKind: z.enum(['percent', 'fixed_amount', 'first_night']),
				}),
				rg_ext: z.array(
					z.object({
						category: z.string(),
						url: z.string().url(),
					}),
				),
			}),
		),
	}),
})

const etgPrebookResponseSchema = z.object({
	status: z.literal('ok'),
	data: z.object({
		partner_order_id: z.string().uuid(),
		bookHash: z.string(),
		expiresAtUtc: z.string().datetime(),
	}),
})

const etgBookResponseSchema = z.object({
	status: z.literal('ok'),
	data: z.object({
		partner_order_id: z.string(),
		stage: z.literal('book'),
	}),
})

const etgBookingInfoResponseSchema = z.object({
	status: z.literal('ok'),
	data: z.object({
		partner_order_id: z.string(),
		stage: z.enum(['search', 'prebook', 'book', 'start', 'check']),
		terminal: z.enum(['confirmed', 'failed']).nullable(),
		stuckTimeoutExceeded: z.boolean().optional(),
	}),
})

const etgWebhookSchema = z.object({
	partner_order_id: z.string(),
	status: z.enum(['confirmed', 'failed']), // D10: terminal-only
	source: z.enum(['ratehawk', 'zenhotels', 'b2b.ostrovok', 'ostrovok']),
})

const etgErrorResponseSchema = z.object({
	status: z.literal('error'),
	error: z.string(),
	errorCode: z.enum(['double_booking_form', 'invalid_request', 'rate_limited', 'sandbox_only']),
})

// =============================================================================
// MSW HANDLERS
// =============================================================================

const server = setupServer(
	http.post(`${ETG_BASE}/search/v1/hotelpage`, async ({ request }) => {
		const auth = request.headers.get('authorization')
		if (!auth?.startsWith('Basic ')) {
			return HttpResponse.json({ status: 'error', error: 'Auth required' }, { status: 401 })
		}
		return HttpResponse.json({
			status: 'ok' as const,
			data: {
				hid: 8473727,
				searchId: 'search-8473727-abc123',
				hotels: [
					{
						priceMicros: '7000000',
						currency: 'RUB' as const,
						cancellationPolicy: {
							referencePoint: 'GuestArrivalTime' as const,
							hoursBeforeRef: 72,
							penaltyKind: 'first_night' as const,
						},
						rg_ext: [
							{ category: 'main', url: 'https://cdn.ostrovok.ru/h/8473727/m1.jpg' },
							{ category: 'lobby', url: 'https://cdn.ostrovok.ru/h/8473727/lobby.jpg' },
						],
					},
				],
			},
		})
	}),

	http.post(`${ETG_BASE}/book/v1/order/booking/finish`, async () => {
		return HttpResponse.json({
			status: 'ok' as const,
			data: {
				partner_order_id: '550e8400-e29b-41d4-a716-446655440000',
				bookHash: 'a1b2c3d4e5f6789012345678',
				expiresAtUtc: new Date(Date.now() + 30 * 60_000).toISOString(),
			},
		})
	}),

	http.post(`${ETG_BASE}/book/v2/booking/finish`, async ({ request }) => {
		const body = (await request.json()) as Record<string, unknown>
		// Simulate double_booking_form collision via header.
		if (request.headers.get('x-test-collision') === 'true') {
			return HttpResponse.json(
				{
					status: 'error' as const,
					error: 'Double booking form detected',
					errorCode: 'double_booking_form' as const,
				},
				{ status: 409 },
			)
		}
		return HttpResponse.json({
			status: 'ok' as const,
			data: {
				partner_order_id: (body.partner_order_id as string) ?? 'unknown',
				stage: 'book' as const,
			},
		})
	}),

	http.get(`${ETG_BASE}/book/v2/booking/info`, async ({ request }) => {
		const url = new URL(request.url)
		const partnerOrderId = url.searchParams.get('partner_order_id') ?? 'unknown'
		return HttpResponse.json({
			status: 'ok' as const,
			data: {
				partner_order_id: partnerOrderId,
				stage: 'check' as const,
				terminal: 'confirmed' as const,
			},
		})
	}),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// =============================================================================
// CONTRACT TESTS
// =============================================================================

describe('Ostrovok ETG API contract — bi-directional schema validation', () => {
	it('[ETG-CONTRACT1] HTTP Basic Auth header — id:uuid base64-encoded', () => {
		const id = 'partner-id-test'
		const uuid = 'partner-uuid-test-1234'
		const expected = `Basic ${Buffer.from(`${id}:${uuid}`, 'utf-8').toString('base64')}`
		expect(expected.startsWith('Basic ')).toBe(true)
		const decoded = Buffer.from(expected.slice('Basic '.length), 'base64').toString('utf-8')
		expect(decoded).toBe(`${id}:${uuid}`)
	})

	it('[ETG-CONTRACT2] /search/v1/hotelpage response — sandbox demo-hotel + rg_ext shape', async () => {
		const auth = `Basic ${Buffer.from('id:uuid', 'utf-8').toString('base64')}`
		const res = await fetch(`${ETG_BASE}/search/v1/hotelpage`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: auth },
			body: JSON.stringify({ hid: 8473727, checkin: '2027-06-15', checkout: '2027-06-17' }),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as unknown
		const parsed = etgSearchResponseSchema.parse(body)
		expect(parsed.data.hid).toBe(8473727)
		expect(parsed.data.hotels[0]?.rg_ext).toHaveLength(2)
		expect(parsed.data.hotels[0]?.rg_ext[0]?.url.startsWith('https://')).toBe(true)
	})

	it('[ETG-CONTRACT3] /book/v1/order/booking/finish prebook response — partner_order_id UUID + bookHash', async () => {
		const auth = `Basic ${Buffer.from('id:uuid', 'utf-8').toString('base64')}`
		const res = await fetch(`${ETG_BASE}/book/v1/order/booking/finish`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: auth },
			body: JSON.stringify({ search_id: 'search-x' }),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as unknown
		const parsed = etgPrebookResponseSchema.parse(body)
		expect(parsed.data.partner_order_id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		)
	})

	it('[ETG-CONTRACT4] /book/v2/booking/finish — happy path returns stage=book', async () => {
		const auth = `Basic ${Buffer.from('id:uuid', 'utf-8').toString('base64')}`
		const res = await fetch(`${ETG_BASE}/book/v2/booking/finish`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: auth },
			body: JSON.stringify({
				partner_order_id: '550e8400-e29b-41d4-a716-446655440000',
				bookHash: 'hash-x',
			}),
		})
		const body = (await res.json()) as unknown
		const parsed = etgBookResponseSchema.parse(body)
		expect(parsed.data.stage).toBe('book')
	})

	it('[ETG-CONTRACT4.b] /book/v2/booking/finish — collision returns error envelope с errorCode=double_booking_form', async () => {
		const auth = `Basic ${Buffer.from('id:uuid', 'utf-8').toString('base64')}`
		const res = await fetch(`${ETG_BASE}/book/v2/booking/finish`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: auth,
				'x-test-collision': 'true',
			},
			body: JSON.stringify({ partner_order_id: 'po-1' }),
		})
		expect(res.status).toBe(409)
		const body = (await res.json()) as unknown
		const parsed = etgErrorResponseSchema.parse(body)
		expect(parsed.errorCode).toBe('double_booking_form')
	})

	it('[ETG-CONTRACT5] /book/v2/booking/info — terminal=confirmed with status check', async () => {
		const auth = `Basic ${Buffer.from('id:uuid', 'utf-8').toString('base64')}`
		const res = await fetch(
			`${ETG_BASE}/book/v2/booking/info?partner_order_id=550e8400-e29b-41d4-a716-446655440000`,
			{
				headers: { authorization: auth },
			},
		)
		const body = (await res.json()) as unknown
		const parsed = etgBookingInfoResponseSchema.parse(body)
		expect(parsed.data.terminal).toBe('confirmed')
	})

	it('[ETG-CONTRACT6] webhook envelope — terminal-only (D10) + 4-brand source enum', () => {
		const validConfirmed = {
			partner_order_id: 'po-1',
			status: 'confirmed' as const,
			source: 'ratehawk' as const,
		}
		const validFailed = {
			partner_order_id: 'po-2',
			status: 'failed' as const,
			source: 'zenhotels' as const,
		}
		expect(etgWebhookSchema.parse(validConfirmed).status).toBe('confirmed')
		expect(etgWebhookSchema.parse(validFailed).status).toBe('failed')
		// Non-terminal status MUST be rejected (parse error) per D10.
		expect(() =>
			etgWebhookSchema.parse({
				partner_order_id: 'po-3',
				status: 'processing',
				source: 'ratehawk',
			}),
		).toThrow()
	})
})
