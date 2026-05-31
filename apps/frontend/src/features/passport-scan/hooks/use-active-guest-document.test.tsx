/**
 * Sprint C+ Round 7 P0 — strict unit tests на useActiveGuestDocument.
 *
 * Covers (per critical-fix coverage canon):
 *   [A1] enabled=false когда guestId null → no fetch fires
 *   [A2] 200 response с data payload → returned as-is
 *   [A3] 200 response с data:null (no active doc) → null
 *   [A4] 404 → null (cross-tenant guard, NOT throw — UI behaves identically)
 *   [A5] 500 → throws с canonical message (UI shows error state)
 *   [A6] response shape exact-value contract — каждое поле verified
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ReactNode } from 'react'

// Hoist api mock BEFORE hook import (Bun mock order matters).
const mockGet = mock<() => Promise<Response>>(async () => new Response('null'))
await mock.module('../../../lib/api', () => ({
	api: {
		api: {
			v1: {
				guests: {
					':guestId': {
						documents: {
							active: {
								$get: mockGet,
							},
						},
					},
				},
			},
		},
	},
}))

const { useActiveGuestDocument } = await import('./use-active-guest-document.ts')

function wrapper({ children }: { children: ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	})
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
	mockGet.mockClear()
})

describe('useActiveGuestDocument', () => {
	test('[A1] enabled=false когда guestId null → no fetch fires', async () => {
		const { result } = renderHook(() => useActiveGuestDocument(null), { wrapper })
		// Sync check immediately — hook returns isPending=false, isLoading=false
		// because enabled:false skips fetch entirely.
		expect(mockGet).not.toHaveBeenCalled()
		expect(result.current.data).toBeUndefined()
	})

	test('[A2] 200 + data payload → returned exactly', async () => {
		mockGet.mockImplementationOnce(
			async () =>
				new Response(
					JSON.stringify({
						data: {
							id: 'gdoc_abc',
							identityMethod: 'passport_zagran',
							documentNumberMaskedTail: '1234',
							citizenshipIso3: 'chn',
							scannedAt: '2026-05-24T10:00:00.000Z',
						},
					}),
					{ status: 200 },
				),
		)
		const { result } = renderHook(() => useActiveGuestDocument('gst_test'), { wrapper })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual({
			id: 'gdoc_abc',
			identityMethod: 'passport_zagran',
			documentNumberMaskedTail: '1234',
			citizenshipIso3: 'chn',
			scannedAt: '2026-05-24T10:00:00.000Z',
		})
	})

	test('[A3] 200 + data:null → null returned (canonical no-doc shape)', async () => {
		mockGet.mockImplementationOnce(
			async () => new Response(JSON.stringify({ data: null }), { status: 200 }),
		)
		const { result } = renderHook(() => useActiveGuestDocument('gst_test'), { wrapper })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBe(null)
	})

	test('[A4] 404 cross-tenant → null (NOT throw — UI behaves identically)', async () => {
		mockGet.mockImplementationOnce(
			async () =>
				new Response(
					JSON.stringify({
						error: { code: 'NOT_FOUND', message: 'Гость не найден' },
					}),
					{ status: 404 },
				),
		)
		const { result } = renderHook(() => useActiveGuestDocument('gst_other_tenant'), { wrapper })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBe(null)
	})

	test('[A5] 500 → throws с canonical message', async () => {
		mockGet.mockImplementationOnce(
			async () => new Response(JSON.stringify({ error: { code: 'INTERNAL' } }), { status: 500 }),
		)
		const { result } = renderHook(() => useActiveGuestDocument('gst_test'), { wrapper })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect((result.current.error as Error).message).toContain('active-document HTTP 500')
	})

	test('[A6] does not fetch когда guestId empty string', async () => {
		const { result } = renderHook(() => useActiveGuestDocument(''), { wrapper })
		expect(mockGet).not.toHaveBeenCalled()
		expect(result.current.data).toBeUndefined()
	})
})
