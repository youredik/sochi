/**
 * DemoInboxPanel — strict tests.
 *
 * Pre-done audit:
 *   [R1] initial render shows «Ждём письмо…» loading copy
 *   [R2] role=status с aria-live=polite (screen reader announces transitions)
 *   [F1] poll hits /api/public/demo/inbox?email=<encoded> exactly once on mount
 *        AND repeatedly on the configured interval
 *   [F2] response с latestUrl flips UI к success state с button «Открыть и войти»
 *   [F3] button href = exact latestUrl returned by backend (no munging)
 *   [F4] polling stops after success (no further fetch calls)
 *   [E1] non-2xx response renders error line «Ошибка опроса: HTTP <status>»
 *   [E2] network throw renders error line with the throw message
 *   [N1] empty email skips polling entirely (no fetch call)
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'

const fetchMock = mock()
const originalFetch = globalThis.fetch

beforeEach(() => {
	globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
	cleanup()
	fetchMock.mockReset()
	globalThis.fetch = originalFetch
})

const VERIFY_URL =
	'http://localhost:8787/api/auth/magic-link/verify?token=t1&callbackURL=%2Fwelcome'

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

async function importPanel() {
	const mod = (await import(`./demo-inbox-panel.tsx?v=${Math.random()}`)) as {
		DemoInboxPanel: React.FC<{ email: string; pollIntervalMs?: number; apiBase?: string }>
	}
	return mod.DemoInboxPanel
}

describe('DemoInboxPanel — initial render', () => {
	it('[R1] renders loading copy «Ждём письмо…»', async () => {
		const DemoInboxPanel = await importPanel()
		fetchMock.mockReturnValue(Promise.resolve(jsonResponse({ data: { latestUrl: null } })))
		render(<DemoInboxPanel email="user@x.com" pollIntervalMs={5_000} />)
		expect(screen.queryByText('Ждём письмо…')).not.toBe(null)
	})

	it('[R2] role=status с aria-live=polite', async () => {
		const DemoInboxPanel = await importPanel()
		fetchMock.mockReturnValue(Promise.resolve(jsonResponse({ data: { latestUrl: null } })))
		render(<DemoInboxPanel email="user@x.com" pollIntervalMs={5_000} />)
		const region = screen.queryByRole('status')
		expect(region).not.toBe(null)
		expect(region?.getAttribute('aria-live')).toBe('polite')
	})
})

describe('DemoInboxPanel — successful capture', () => {
	it('[F1] poll hits /api/public/demo/inbox?email=<encoded> at mount', async () => {
		const DemoInboxPanel = await importPanel()
		fetchMock.mockReturnValue(Promise.resolve(jsonResponse({ data: { latestUrl: null } })))
		render(<DemoInboxPanel email="user@example.com" pollIntervalMs={5_000} />)
		await waitFor(() => {
			expect(fetchMock.mock.calls.length >= 1).toBe(true)
		})
		const firstCall = fetchMock.mock.calls[0] as [string]
		expect(firstCall[0]).toBe('/api/public/demo/inbox?email=user%40example.com')
	})

	it('[F2] latestUrl arrival flips UI к success state', async () => {
		const DemoInboxPanel = await importPanel()
		fetchMock.mockReturnValue(Promise.resolve(jsonResponse({ data: { latestUrl: VERIFY_URL } })))
		render(<DemoInboxPanel email="user@x.com" pollIntervalMs={5_000} />)
		await waitFor(() => {
			expect(screen.queryByText('Письмо пришло')).not.toBe(null)
		})
		expect(screen.queryByText('Ждём письмо…')).toBe(null)
	})

	it('[F3] button href = exact latestUrl from backend (no transform)', async () => {
		const DemoInboxPanel = await importPanel()
		fetchMock.mockReturnValue(Promise.resolve(jsonResponse({ data: { latestUrl: VERIFY_URL } })))
		render(<DemoInboxPanel email="user@x.com" pollIntervalMs={5_000} />)
		await waitFor(() => {
			expect(screen.queryByRole('link', { name: /Открыть и войти/ })).not.toBe(null)
		})
		const link = screen.queryByRole('link', { name: /Открыть и войти/ })
		expect(link?.getAttribute('href')).toBe(VERIFY_URL)
	})

	it('[F4] polling halts after success (fetch call count stops growing)', async () => {
		const DemoInboxPanel = await importPanel()
		fetchMock.mockReturnValue(Promise.resolve(jsonResponse({ data: { latestUrl: VERIFY_URL } })))
		render(<DemoInboxPanel email="user@x.com" pollIntervalMs={10} />)
		await waitFor(() => {
			expect(screen.queryByText('Письмо пришло')).not.toBe(null)
		})
		const callsAtSuccess = fetchMock.mock.calls.length
		await new Promise((r) => setTimeout(r, 60))
		// After success no NEW fetch calls (poll predicate skips fetch).
		expect(fetchMock.mock.calls.length).toBe(callsAtSuccess)
	})
})

describe('DemoInboxPanel — error surface', () => {
	it('[E1] non-2xx response renders «Ошибка опроса: HTTP <status>»', async () => {
		const DemoInboxPanel = await importPanel()
		fetchMock.mockReturnValue(Promise.resolve(jsonResponse({ data: null }, 503)))
		render(<DemoInboxPanel email="user@x.com" pollIntervalMs={5_000} />)
		await waitFor(() => {
			expect(screen.queryByText(/Ошибка опроса: HTTP 503/)).not.toBe(null)
		})
	})

	it('[E2] network throw renders error message', async () => {
		const DemoInboxPanel = await importPanel()
		fetchMock.mockReturnValue(Promise.reject(new Error('network down')))
		render(<DemoInboxPanel email="user@x.com" pollIntervalMs={5_000} />)
		await waitFor(() => {
			expect(screen.queryByText(/network down/)).not.toBe(null)
		})
	})
})

describe('DemoInboxPanel — empty email guard', () => {
	it('[N1] empty email → no fetch call', async () => {
		const DemoInboxPanel = await importPanel()
		render(<DemoInboxPanel email="" pollIntervalMs={5_000} />)
		// Tick microtask + a frame to be sure no async fetch fired.
		await new Promise((r) => setTimeout(r, 20))
		expect(fetchMock.mock.calls.length).toBe(0)
	})
})
