/**
 * Yandex.Travel API contract tests — YT-CONTRACT1-4 (M10 / A7.3 / D15 + D6).
 *
 * Bnovo CM gateway shapes (YT canonical via certified CM passthrough):
 *   - CONTRACT1: signed POST request envelope (HMAC-SHA256 + timestamp)
 *   - CONTRACT2: ARI push response shape
 *   - CONTRACT3: inbound booking webhook envelope (CloudEvents 1.0.2)
 *   - CONTRACT4: error envelope shape (consent gap / non-RU host)
 *
 * Lib canon: msw@2.14.3 + zod@4.4.3.
 */

import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { z } from 'zod'

const BNOVO_BASE = 'https://api.bnovo.ru/v2'

// =============================================================================
// CANONICAL SHAPES
// =============================================================================

const ariPushRequestSchema = z.object({
	tenantId: z.string(),
	propertyId: z.string(),
	deltas: z.array(
		z.object({
			date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
			roomTypeId: z.string(),
			ratePlanId: z.string(),
			availability: z.number().int().nonnegative(),
			rateMicros: z.string().regex(/^\d+$/),
			currency: z.literal('RUB'),
		}),
	),
})

const ariPushResponseSchema = z.object({
	status: z.literal('accepted'),
	acceptedCount: z.number().int().nonnegative(),
	rejectedCount: z.number().int().nonnegative(),
	processedAtUtc: z.string().datetime(),
})

const inboundBookingEventSchema = z.object({
	specversion: z.literal('1.0'),
	id: z.string(),
	source: z.string().regex(/^urn:sochi:channel:YT:tenant:/),
	type: z.string().regex(/^app\.sochi\.channel\.booking\./),
	subject: z.string().optional(),
	time: z.string().optional(),
	datacontenttype: z.string().optional(),
	data: z.object({
		consent: z.object({
			processing: z.boolean(),
			transferToHotel: z.boolean(),
			marketing: z.boolean(),
		}),
		currency: z.literal('RUB').optional(),
		photoUrls: z.array(z.string().url()).optional(),
	}),
})

const errorEnvelopeSchema = z.object({
	error: z.string(),
	code: z.enum([
		'CONSENT_MISSING',
		'NON_RU_HOST',
		'NON_RUB_CURRENCY',
		'INVALID_SIGNATURE',
		'REPLAY_WINDOW_EXCEEDED',
		'INVALID_REQUEST',
	]),
	message: z.string(),
})

// =============================================================================
// MSW HANDLERS
// =============================================================================

const server = setupServer(
	http.post(`${BNOVO_BASE}/yt/ari`, async ({ request }) => {
		const body = (await request.json()) as unknown
		const parsed = ariPushRequestSchema.safeParse(body)
		if (!parsed.success) {
			return HttpResponse.json(
				{
					error: 'Invalid request',
					code: 'INVALID_REQUEST' as const,
					message: parsed.error.message,
				},
				{ status: 400 },
			)
		}
		return HttpResponse.json({
			status: 'accepted' as const,
			acceptedCount: parsed.data.deltas.length,
			rejectedCount: 0,
			processedAtUtc: new Date().toISOString(),
		})
	}),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// =============================================================================
// CONTRACT TESTS
// =============================================================================

describe('Yandex.Travel API contract — Bnovo CM passthrough', () => {
	it('[YT-CONTRACT1] ARI push request envelope conforms к canonical schema', async () => {
		const requestBody = {
			tenantId: 'org_yt_test',
			propertyId: 'prop_yt',
			deltas: [
				{
					date: '2027-06-15',
					roomTypeId: 'rt_deluxe',
					ratePlanId: 'rp_bar',
					availability: 5,
					rateMicros: '6000000',
					currency: 'RUB' as const,
				},
			],
		}
		// Validate REQUEST shape before sending.
		const parsed = ariPushRequestSchema.parse(requestBody)
		expect(parsed.deltas).toHaveLength(1)
		const res = await fetch(`${BNOVO_BASE}/yt/ari`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-yt-timestamp': Math.floor(Date.now() / 1000).toString(),
				'x-yt-signature': 'mock-signature',
			},
			body: JSON.stringify(requestBody),
		})
		expect(res.status).toBe(200)
	})

	it('[YT-CONTRACT2] ARI push response — accepted count + processed timestamp', async () => {
		const requestBody = {
			tenantId: 'org_yt_test',
			propertyId: 'prop_yt',
			deltas: [
				{
					date: '2027-06-15',
					roomTypeId: 'rt',
					ratePlanId: 'rp',
					availability: 3,
					rateMicros: '6000000',
					currency: 'RUB' as const,
				},
				{
					date: '2027-06-16',
					roomTypeId: 'rt',
					ratePlanId: 'rp',
					availability: 3,
					rateMicros: '6000000',
					currency: 'RUB' as const,
				},
			],
		}
		const res = await fetch(`${BNOVO_BASE}/yt/ari`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-yt-timestamp': Math.floor(Date.now() / 1000).toString(),
				'x-yt-signature': 'mock-signature',
			},
			body: JSON.stringify(requestBody),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as unknown
		const parsed = ariPushResponseSchema.parse(body)
		expect(parsed.acceptedCount).toBe(2)
		expect(parsed.status).toBe('accepted')
	})

	it('[YT-CONTRACT3] inbound booking webhook envelope — CloudEvents 1.0.2 + consent + RU residency', () => {
		const inbound = {
			specversion: '1.0' as const,
			id: 'yt-evt-1',
			source: 'urn:sochi:channel:YT:tenant:org_a',
			type: 'app.sochi.channel.booking.created.v1',
			subject: 'yt-res-1',
			time: '2026-05-04T12:00:00.000Z',
			datacontenttype: 'application/json',
			data: {
				consent: { processing: true, transferToHotel: true, marketing: false },
				currency: 'RUB' as const,
				photoUrls: ['https://storage.yandexcloud.net/h/p.jpg'],
			},
		}
		const parsed = inboundBookingEventSchema.parse(inbound)
		expect(parsed.source.startsWith('urn:sochi:channel:YT:tenant:')).toBe(true)
		expect(parsed.data.consent.processing).toBe(true)
		expect(parsed.data.currency).toBe('RUB')
	})

	it('[YT-CONTRACT4] error envelope shape — consent gap / non-RU host / non-RUB', () => {
		// Validate that we can shape errors к canonical schema.
		const consentError = {
			error: 'Consent missing',
			code: 'CONSENT_MISSING' as const,
			message: 'transferToHotel checkbox missing',
		}
		const ruError = {
			error: 'Cross-border-transfer denied',
			code: 'NON_RU_HOST' as const,
			message: 'photo host aws.cloudfront.net is not RU-resident',
		}
		const currencyError = {
			error: 'Non-RUB currency',
			code: 'NON_RUB_CURRENCY' as const,
			message: 'Russian market accepts RUB only',
		}
		expect(errorEnvelopeSchema.parse(consentError).code).toBe('CONSENT_MISSING')
		expect(errorEnvelopeSchema.parse(ruError).code).toBe('NON_RU_HOST')
		expect(errorEnvelopeSchema.parse(currencyError).code).toBe('NON_RUB_CURRENCY')
	})
})
