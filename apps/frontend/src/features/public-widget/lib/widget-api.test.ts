/**
 * Widget API client — strict tests per `feedback_strict_tests.md`.
 *
 * Test matrix:
 *   ─── listPublicProperties ─────────────────────────────────────
 *     [LP1] HTTP 200 → returns view с tenant + properties
 *     [LP2] HTTP 404 → returns null (sentinel для UI not-found state)
 *     [LP3] HTTP 500 → throws Error (callers handle via React Query isError)
 *     [LP4] tenantSlug is encodeURIComponent'd (special chars don't break URL)
 *
 *   ─── getPublicPropertyDetail ──────────────────────────────────
 *     [PD1] HTTP 200 → returns detail с tenant + property + roomTypes
 *     [PD2] HTTP 404 → returns null
 *     [PD3] both tenantSlug AND propertyId encodeURIComponent'd
 *
 *   ─── HTTP method + headers ────────────────────────────────────
 *     [H1] always uses GET
 *     [H2] sets Accept: application/json header
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { getPublicPropertyDetail, listPublicProperties } from './widget-api.ts'

describe('widget-api — listPublicProperties', () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, 'fetch')
	})

	afterEach(() => {
		fetchSpy.mockRestore()
	})

	test('[LP1] 200 → returns view с tenant + properties', async () => {
		fetchSpy.mockResolvedValue(
			new Response(
				JSON.stringify({
					data: {
						tenant: { slug: 'demo-sirius', name: 'Демо', mode: 'demo' },
						properties: [
							{
								id: 'p1',
								name: 'Sea View',
								address: 'Сириус 1',
								city: 'Сочи',
								timezone: 'Europe/Moscow',
								tourismTaxRateBps: 200,
							},
						],
					},
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		)
		const view = await listPublicProperties('demo-sirius')
		expect(view).not.toBeNull()
		expect(view?.tenant.slug).toBe('demo-sirius')
		expect(view?.tenant.mode).toBe('demo')
		expect(view?.properties).toHaveLength(1)
		expect(view?.properties[0]?.tourismTaxRateBps).toBe(200)
	})

	test('[LP2] 404 → returns null (UI sentinel)', async () => {
		fetchSpy.mockResolvedValue(
			new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 }),
		)
		const view = await listPublicProperties('does-not-exist')
		expect(view).toBeNull()
	})

	test('[LP3] 500 → throws Error', async () => {
		fetchSpy.mockResolvedValue(new Response('upstream', { status: 500 }))
		await expect(listPublicProperties('demo-sirius')).rejects.toThrow(/HTTP 500/)
	})

	test('[LP4] tenantSlug encodeURIComponent в URL', async () => {
		fetchSpy.mockResolvedValue(
			new Response(
				JSON.stringify({ data: { tenant: { slug: 'a', name: 'A', mode: null }, properties: [] } }),
				{
					status: 200,
				},
			),
		)
		await listPublicProperties('hotel/with/slashes')
		expect(fetchSpy).toHaveBeenCalledWith(
			expect.stringContaining('/hotel%2Fwith%2Fslashes/properties'),
			expect.any(Object),
		)
	})
})

describe('widget-api — getPublicPropertyDetail', () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, 'fetch')
	})

	afterEach(() => {
		fetchSpy.mockRestore()
	})

	test('[PD1] 200 → returns detail с tenant + property + roomTypes', async () => {
		fetchSpy.mockResolvedValue(
			new Response(
				JSON.stringify({
					data: {
						tenant: { slug: 'demo-sirius', name: 'Демо', mode: 'demo' },
						property: {
							id: 'p1',
							name: 'Sea View',
							address: 'Сириус 1',
							city: 'Сочи',
							timezone: 'Europe/Moscow',
							tourismTaxRateBps: 200,
						},
						roomTypes: [
							{
								id: 'rt1',
								propertyId: 'p1',
								name: 'Deluxe',
								description: '25 м²',
								maxOccupancy: 2,
								baseBeds: 1,
							},
						],
					},
				}),
				{ status: 200 },
			),
		)
		const detail = await getPublicPropertyDetail('demo-sirius', 'p1')
		expect(detail).not.toBeNull()
		expect(detail?.property.id).toBe('p1')
		expect(detail?.roomTypes).toHaveLength(1)
		expect(detail?.roomTypes[0]?.name).toBe('Deluxe')
	})

	test('[PD2] 404 → returns null', async () => {
		fetchSpy.mockResolvedValue(new Response(null, { status: 404 }))
		const detail = await getPublicPropertyDetail('demo-sirius', 'unknown')
		expect(detail).toBeNull()
	})

	test('[PD3] both tenantSlug AND propertyId encodeURIComponent', async () => {
		fetchSpy.mockResolvedValue(
			new Response(
				JSON.stringify({
					data: {
						tenant: { slug: 'a', name: 'A', mode: null },
						property: {
							id: 'p',
							name: 'p',
							address: '',
							city: '',
							timezone: 'UTC',
							tourismTaxRateBps: null,
						},
						roomTypes: [],
					},
				}),
				{ status: 200 },
			),
		)
		await getPublicPropertyDetail('slug/with/slash', 'id with space')
		expect(fetchSpy).toHaveBeenCalledWith(
			expect.stringContaining('/slug%2Fwith%2Fslash/properties/id%20with%20space'),
			expect.any(Object),
		)
	})
})

describe('widget-api — HTTP method + headers', () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, 'fetch')
		fetchSpy.mockResolvedValue(
			new Response(
				JSON.stringify({ data: { tenant: { slug: 'a', name: 'A', mode: null }, properties: [] } }),
				{
					status: 200,
				},
			),
		)
	})

	afterEach(() => {
		fetchSpy.mockRestore()
	})

	test('[H1] always uses GET method', async () => {
		await listPublicProperties('demo-sirius')
		expect(fetchSpy).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ method: 'GET' }),
		)
	})

	test('[H2] sets Accept: application/json header', async () => {
		await listPublicProperties('demo-sirius')
		expect(fetchSpy).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				headers: expect.objectContaining({ Accept: 'application/json' }),
			}),
		)
	})
})
