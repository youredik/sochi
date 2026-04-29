/**
 * `useAvailability` — strict tests via TanStack Query test renderer.
 *
 * Covers:
 *   [UA1] Successful fetch → returns data with offerings
 *   [UA2] 404 from API → returns null cleanly
 *   [UA3] 422 invalid input → query.error instanceof WidgetApiInputError
 *   [UA4] enabled=false → no fetch fired
 *   [UA5] Different params → different cacheKey (no cross-leak)
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WidgetApiInputError } from '../lib/widget-api.ts'
import { useAvailability } from './use-availability.ts'

let originalFetch: typeof globalThis.fetch
afterEach(() => {
	cleanup()
	globalThis.fetch = originalFetch
	vi.restoreAllMocks()
})
beforeEach(() => {
	originalFetch = globalThis.fetch
})

function makeQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
		},
	})
}

interface ProbeProps {
	tenantSlug: string
	propertyId: string
	checkIn: string
	checkOut: string
	adults: number
	childrenCount: number
	enabled?: boolean
	onResult: (r: ReturnType<typeof useAvailability>) => void
}

function Probe(props: ProbeProps) {
	const { onResult, enabled, childrenCount, ...rest } = props
	const result = useAvailability({ ...rest, children: childrenCount }, { enabled: enabled ?? true })
	onResult(result)
	return null
}

function renderProbe(props: ProbeProps): { client: QueryClient } {
	const client = makeQueryClient()
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	)
	render(<Probe {...props} />, { wrapper })
	return { client }
}

describe('useAvailability', () => {
	test('[UA1] successful fetch returns data with offerings', async () => {
		const responseData = {
			tenant: { slug: 'demo', name: 'Demo', mode: 'demo' as const },
			property: {
				id: 'p1',
				name: 'Prop',
				address: 'a',
				city: 'Sochi',
				timezone: 'Europe/Moscow',
				tourismTaxRateBps: 200,
			},
			checkIn: '2026-06-01',
			checkOut: '2026-06-03',
			nights: 2,
			adults: 2,
			children: 0,
			offerings: [],
			photos: [],
		}
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ data: responseData }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		) as unknown as typeof fetch

		const capture = { value: null as ReturnType<typeof useAvailability> | null }
		renderProbe({
			tenantSlug: 'demo',
			propertyId: 'p1',
			checkIn: '2026-06-01',
			checkOut: '2026-06-03',
			adults: 2,
			childrenCount: 0,
			onResult: (r) => {
				capture.value = r
			},
		})

		await waitFor(() => {
			expect(capture.value?.isSuccess).toBe(true)
		})
		expect(capture.value?.data?.nights).toBe(2)
	})

	test('[UA2] 404 returns null cleanly', async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(new Response('null', { status: 404 })) as unknown as typeof fetch

		const capture = { value: null as ReturnType<typeof useAvailability> | null }
		renderProbe({
			tenantSlug: 'unknown',
			propertyId: 'p1',
			checkIn: '2026-06-01',
			checkOut: '2026-06-03',
			adults: 2,
			childrenCount: 0,
			onResult: (r) => {
				capture.value = r
			},
		})
		await waitFor(() => expect(capture.value?.isSuccess).toBe(true))
		expect(capture.value?.data).toBeNull()
	})

	test('[UA3] 422 → query.error instanceof WidgetApiInputError', async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ error: { code: 'INVALID_INPUT', message: 'stay too long' } }),
					{ status: 422, headers: { 'content-type': 'application/json' } },
				),
			) as unknown as typeof fetch

		const capture = { value: null as ReturnType<typeof useAvailability> | null }
		renderProbe({
			tenantSlug: 'demo',
			propertyId: 'p1',
			checkIn: '2026-06-01',
			checkOut: '2026-08-01',
			adults: 2,
			childrenCount: 0,
			onResult: (r) => {
				capture.value = r
			},
		})
		await waitFor(
			() => {
				expect(capture.value?.isError).toBe(true)
			},
			{ timeout: 3000 },
		)
		expect(capture.value?.error).toBeInstanceOf(WidgetApiInputError)
	})

	test('[UA4] enabled=false → no fetch fired', async () => {
		const fetchSpy = vi.fn()
		globalThis.fetch = fetchSpy as unknown as typeof fetch
		renderProbe({
			tenantSlug: 'demo',
			propertyId: 'p1',
			checkIn: '2026-06-01',
			checkOut: '2026-06-03',
			adults: 2,
			childrenCount: 0,
			enabled: false,
			onResult: () => {},
		})
		// Wait one microtask to ensure no async-scheduled fetch fired
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20))
		})
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	test('[UA6] 500 server error → query.error generic Error (NOT WidgetApiInputError) → caller renders fallback', async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(new Response('Internal error', { status: 500 })) as unknown as typeof fetch

		const capture = { value: null as ReturnType<typeof useAvailability> | null }
		renderProbe({
			tenantSlug: 'demo',
			propertyId: 'p1',
			checkIn: '2026-06-01',
			checkOut: '2026-06-03',
			adults: 2,
			childrenCount: 0,
			onResult: (r) => {
				capture.value = r
			},
		})
		await waitFor(() => expect(capture.value?.isError).toBe(true), { timeout: 3000 })
		// Generic Error — NOT WidgetApiInputError — search-and-pick рендерит generic fallback
		expect(capture.value?.error).toBeInstanceOf(Error)
		expect(capture.value?.error).not.toBeInstanceOf(WidgetApiInputError)
		expect(capture.value?.error?.message).toMatch(/HTTP 500/)
	})

	test('[UA7] network failure (fetch reject) → query.error TypeError (NOT silent loading)', async () => {
		globalThis.fetch = vi
			.fn()
			.mockRejectedValue(new TypeError('Network failure')) as unknown as typeof fetch

		const capture = { value: null as ReturnType<typeof useAvailability> | null }
		renderProbe({
			tenantSlug: 'demo',
			propertyId: 'p1',
			checkIn: '2026-06-01',
			checkOut: '2026-06-03',
			adults: 2,
			childrenCount: 0,
			onResult: (r) => {
				capture.value = r
			},
		})
		await waitFor(() => expect(capture.value?.isError).toBe(true), { timeout: 3000 })
		expect(capture.value?.isLoading).toBe(false)
	})

	test('[UA5] different adults param → different queryKey (no cross-leak)', async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ data: {} }), { status: 200 }),
			) as unknown as typeof fetch
		globalThis.fetch = fetchSpy

		const client = makeQueryClient()
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		)
		render(
			<>
				<Probe
					tenantSlug="demo"
					propertyId="p1"
					checkIn="2026-06-01"
					checkOut="2026-06-03"
					adults={2}
					childrenCount={0}
					onResult={() => {}}
				/>
				<Probe
					tenantSlug="demo"
					propertyId="p1"
					checkIn="2026-06-01"
					checkOut="2026-06-03"
					adults={3}
					childrenCount={0}
					onResult={() => {}}
				/>
			</>,
			{ wrapper },
		)
		await waitFor(() => {
			expect((fetchSpy as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2)
		})
	})
})
