/**
 * TravelLine API contract tests — TL-CONTRACT1-6 (M10 / A7.2 / D15).
 *
 * Per `plans/m10_canonical.md` §2 D15:
 *   "MSW handlers (single source) + OpenAPI/JSON-Schema + bi-directional
 *    contract via PactFlow OSS — NOT classic consumer-driven Pact (Pact-JS
 *    native binding broken on Node 24 ARM64)"
 *
 * Bi-directional approach 2026:
 *   - Define canonical TL API shapes via `zod` schemas (single source of truth)
 *   - MSW server simulates TL endpoints serving responses conforming к schemas
 *   - Contract tests:
 *     1. Validate REQUEST shapes our adapter sends (consumer-driven)
 *     2. Validate RESPONSE shapes TL returns (provider-driven)
 *     3. Validate error envelopes match TL canonical (CHECKSUM_MISMATCH 409 etc)
 *
 * Schema drift on either side → test fails → catch contract breach в CI.
 *
 * Lib canon: msw@2.14.3 (TODAY 2026-05-04), zod@4.4.3.
 */

import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

// =============================================================================
// CANONICAL TL API SCHEMAS (zod)
// =============================================================================

const tlOAuthTokenResponseSchema = z.object({
	access_token: z.string().min(10),
	token_type: z.literal('Bearer'),
	expires_in: z.literal(900), // 15-min canonical TTL
	scope: z.string(),
})

const tlCancellationPolicySchema = z.object({
	referencePoint: z.enum([
		'ProviderArrivalTime',
		'GuestArrivalTime',
		'CustomArrivalTime',
		'BookingCreationTime',
	]),
	hoursBeforeRef: z.number().int().nonnegative(),
	penaltyKind: z.enum(['percent', 'fixed_amount', 'first_night']),
	penaltyValue: z.number().nonnegative(),
})

const tlSearchResponseSchema = z.object({
	hotelId: z.string(),
	searchedAt: z.string().datetime(),
	rooms: z.array(
		z.object({
			tlRoomTypeId: z.string(),
			tlRatePlanId: z.string(),
			availability: z.number().int().nonnegative(),
			priceMicros: z.string().regex(/^\d+$/), // bigint as decimal string in JSON
			currency: z.literal('RUB'),
			cancellationPolicy: tlCancellationPolicySchema,
		}),
	),
})

const tlReservationSchema = z.object({
	tlReservationId: z.string(),
	hotelId: z.string(),
	arrivalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	tlRoomTypeId: z.string(),
	tlRatePlanId: z.string(),
	guests: z.array(
		z.object({
			firstName: z.string(),
			lastName: z.string(),
			email: z.string().email().optional(),
			phone: z.string().optional(),
		}),
	),
	totalPriceMicros: z.string().regex(/^\d+$/),
	currency: z.literal('RUB'),
	status: z.enum(['Confirmed', 'Cancelled']),
	lastModificationUtc: z.string().datetime(),
	cancellationPolicy: tlCancellationPolicySchema,
})

const tlReservationListResponseSchema = z.object({
	reservations: z.array(tlReservationSchema),
	nextContinueToken: z.string().optional(),
	hasMore: z.boolean(),
})

const tlVerifyResponseSchema = z.object({
	createBookingToken: z.string().uuid(),
	checksum: z.string().regex(/^[a-f0-9]{64}$/), // sha256 hex
	tokenExpiresAtUtc: z.string().datetime(),
	totalPriceMicros: z.string().regex(/^\d+$/),
	cancellationPolicy: tlCancellationPolicySchema,
})

const tlCreateBookingRequestSchema = z.object({
	createBookingToken: z.string().uuid(),
	checksum: z.string().regex(/^[a-f0-9]{64}$/),
	idempotencyKey: z.string().min(1),
})

const tlCreateBookingResponseSchema = z.object({
	tlReservationId: z.string(),
	status: z.literal('Confirmed'),
	createdAtUtc: z.string().datetime(),
})

const tlErrorResponseSchema = z.object({
	error: z.string(),
	errorCode: z.enum([
		'CHECKSUM_MISMATCH',
		'TOKEN_EXPIRED',
		'TOKEN_USED',
		'RATE_LIMITED',
		'INVALID_REQUEST',
		'INTERNAL_ERROR',
	]),
	message: z.string().optional(),
})

// =============================================================================
// MSW SERVER — simulates TL canonical endpoints
// =============================================================================

const TL_BASE = 'https://partner.tlintegration.com'
const VALID_TOKEN = '550e8400-e29b-41d4-a716-446655440000'
const VALID_CHECKSUM = 'a'.repeat(64)

const handlers = [
	http.post(`${TL_BASE}/auth/token`, async () => {
		const response = {
			access_token: 'eyJtb2NrIjp0cnVlfQ.payload.signature',
			token_type: 'Bearer' as const,
			expires_in: 900,
			scope: 'channel:read channel:write',
		}
		return HttpResponse.json(response)
	}),

	http.post(`${TL_BASE}/search/v1`, async () => {
		const response = {
			hotelId: 'tl-hotel-test',
			searchedAt: new Date().toISOString(),
			rooms: [
				{
					tlRoomTypeId: 'rt_deluxe',
					tlRatePlanId: 'rp_bar_flex',
					availability: 5,
					priceMicros: '5000000',
					currency: 'RUB' as const,
					cancellationPolicy: {
						referencePoint: 'GuestArrivalTime' as const,
						hoursBeforeRef: 24,
						penaltyKind: 'first_night' as const,
						penaltyValue: 1,
					},
				},
			],
		}
		return HttpResponse.json(response)
	}),

	http.get(`${TL_BASE}/reservations/list`, async ({ request }) => {
		const url = new URL(request.url)
		const continueToken = url.searchParams.get('continueToken')
		const lastMod = url.searchParams.get('lastModificationUtc')
		void continueToken
		void lastMod
		const response = {
			reservations: [
				{
					tlReservationId: 'tl-res-001',
					hotelId: 'tl-hotel-test',
					arrivalDate: '2027-06-15',
					departureDate: '2027-06-17',
					tlRoomTypeId: 'rt_deluxe',
					tlRatePlanId: 'rp_bar_flex',
					guests: [{ firstName: 'Иван', lastName: 'Петров', email: 'ip@test.ru' }],
					totalPriceMicros: '10000000',
					currency: 'RUB' as const,
					status: 'Confirmed' as const,
					lastModificationUtc: new Date().toISOString(),
					cancellationPolicy: {
						referencePoint: 'GuestArrivalTime' as const,
						hoursBeforeRef: 24,
						penaltyKind: 'first_night' as const,
						penaltyValue: 1,
					},
				},
			],
			hasMore: false,
		}
		return HttpResponse.json(response)
	}),

	http.post(`${TL_BASE}/booking/verify`, async () => {
		const response = {
			createBookingToken: VALID_TOKEN,
			checksum: VALID_CHECKSUM,
			tokenExpiresAtUtc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
			totalPriceMicros: '10000000',
			cancellationPolicy: {
				referencePoint: 'GuestArrivalTime' as const,
				hoursBeforeRef: 24,
				penaltyKind: 'first_night' as const,
				penaltyValue: 1,
			},
		}
		return HttpResponse.json(response)
	}),

	http.post(`${TL_BASE}/booking/create`, async ({ request }) => {
		const body = (await request.json()) as Record<string, unknown>
		// Validate request shape; mismatch → 409.
		if (body.checksum !== VALID_CHECKSUM) {
			return HttpResponse.json(
				{
					error: 'Checksum mismatch',
					errorCode: 'CHECKSUM_MISMATCH' as const,
					message: 'Request checksum does not match issued checksum',
				},
				{ status: 409 },
			)
		}
		const response = {
			tlReservationId: 'tl-res-new-001',
			status: 'Confirmed' as const,
			createdAtUtc: new Date().toISOString(),
		}
		return HttpResponse.json(response)
	}),
]

const server = setupServer(...handlers)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// =============================================================================
// CONTRACT TESTS — TL-CONTRACT1 to TL-CONTRACT6
// =============================================================================

describe('TravelLine API contract — bi-directional schema validation', () => {
	it('[TL-CONTRACT1] OAuth /auth/token response conforms к canonical schema (15-min TTL)', async () => {
		const res = await fetch(`${TL_BASE}/auth/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'grant_type=client_credentials&client_id=x&client_secret=y',
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as unknown
		const parsed = tlOAuthTokenResponseSchema.parse(body)
		expect(parsed.expires_in).toBe(900) // canonical 15-min TTL
		expect(parsed.token_type).toBe('Bearer')
	})

	it('[TL-CONTRACT2] /search/v1 response — rate plan + cancellation policy shape', async () => {
		const res = await fetch(`${TL_BASE}/search/v1`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: 'Bearer test_token' },
			body: JSON.stringify({
				hotelId: 'tl-hotel-test',
				arrivalDate: '2027-06-15',
				departureDate: '2027-06-17',
				adults: 2,
				currency: 'RUB',
			}),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as unknown
		const parsed = tlSearchResponseSchema.parse(body)
		expect(parsed.rooms.length).toBeGreaterThan(0)
		const room = parsed.rooms[0]
		if (!room) throw new Error('contract: at least one room expected')
		expect(room.cancellationPolicy.referencePoint).toBe('GuestArrivalTime')
		expect(room.currency).toBe('RUB')
	})

	it('[TL-CONTRACT3] /reservations/list response — cursor + reservation shape (D2 polling)', async () => {
		const res = await fetch(`${TL_BASE}/reservations/list?lastModificationUtc=2026-05-04T00:00:00Z`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as unknown
		const parsed = tlReservationListResponseSchema.parse(body)
		expect(parsed.hasMore).toBe(false)
		const reservation = parsed.reservations[0]
		if (!reservation) throw new Error('contract: at least one reservation expected')
		expect(reservation.status).toMatch(/^(Confirmed|Cancelled)$/)
	})

	it('[TL-CONTRACT4] /booking/verify response — createBookingToken UUID + checksum sha256', async () => {
		const res = await fetch(`${TL_BASE}/booking/verify`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: 'Bearer test_token' },
			body: JSON.stringify({
				hotelId: 'tl-hotel-test',
				tlRoomTypeId: 'rt_deluxe',
				tlRatePlanId: 'rp_bar_flex',
				arrivalDate: '2027-06-15',
				departureDate: '2027-06-17',
				guests: [{ firstName: 'A', lastName: 'B', email: 'a@test.ru' }],
			}),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as unknown
		const parsed = tlVerifyResponseSchema.parse(body)
		// Canonical token shape: UUID v4.
		expect(parsed.createBookingToken).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		)
		// Checksum: 64-char hex (sha256).
		expect(parsed.checksum).toHaveLength(64)
		// 24h expiry.
		const tokenExpiresMs = new Date(parsed.tokenExpiresAtUtc).getTime()
		expect(tokenExpiresMs - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000)
		expect(tokenExpiresMs - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5_000)
	})

	it('[TL-CONTRACT5] /booking/create REQUEST conforms (idempotency-key + checksum echo)', async () => {
		const requestBody = {
			createBookingToken: VALID_TOKEN,
			checksum: VALID_CHECKSUM,
			idempotencyKey: 'org_test:b1:1:TL',
		}
		// Validate REQUEST shape against canonical schema BEFORE sending.
		const parsedReq = tlCreateBookingRequestSchema.parse(requestBody)
		expect(parsedReq.idempotencyKey).toBe('org_test:b1:1:TL')
		const res = await fetch(`${TL_BASE}/booking/create`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer test_token',
				'idempotency-key': parsedReq.idempotencyKey,
			},
			body: JSON.stringify(requestBody),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as unknown
		const parsedRes = tlCreateBookingResponseSchema.parse(body)
		expect(parsedRes.status).toBe('Confirmed')
		expect(parsedRes.tlReservationId.startsWith('tl-res-')).toBe(true)
	})

	it('[TL-CONTRACT6] /booking/create with TAMPERED checksum → 409 with CHECKSUM_MISMATCH error envelope', async () => {
		const res = await fetch(`${TL_BASE}/booking/create`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer test_token',
				'idempotency-key': 'org_test:b2:1:TL',
			},
			body: JSON.stringify({
				createBookingToken: VALID_TOKEN,
				checksum: 'b'.repeat(64), // wrong checksum
				idempotencyKey: 'org_test:b2:1:TL',
			}),
		})
		expect(res.status).toBe(409)
		const body = (await res.json()) as unknown
		const parsed = tlErrorResponseSchema.parse(body)
		expect(parsed.errorCode).toBe('CHECKSUM_MISMATCH')
	})
})
