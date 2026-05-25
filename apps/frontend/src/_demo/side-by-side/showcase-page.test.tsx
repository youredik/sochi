/**
 * <ShowcasePage> — strict tests.
 *
 * Coverage:
 *   [S1] Default render: channel = yandex (left iframe → /demo/ota/yandex)
 *   [S2] Switch channel to ostrovok updates left iframe src
 *   [S3] Reset button POSTs to /api/_mock-ota/admin/reset and shows success
 *   [S4] Seed button POSTs to /api/_mock-ota/admin/seed and shows success
 *   [S5] Trigger button POSTs scenario body to /api/_mock-ota/admin/trigger
 *   [S6] Error response surfaces в status banner
 *   [S7] PMS iframe defaults to /o/demo/grid
 *   [S8] PMS iframe respects pmsGridUrl prop override
 *   [S9] Initial channel respects initialChannel prop
 *   [S10] aria-pressed reflects active channel
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ShowcasePage } from './showcase-page.tsx'

afterEach(() => {
	cleanup()
})

interface FetchCall {
	url: string
	init: RequestInit | undefined
}

function buildFetchSpy(
	opts: { responder?: (call: FetchCall) => Response | Promise<Response> } = {},
) {
	const calls: FetchCall[] = []
	const spy = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		calls.push({ url, init })
		if (opts.responder) return opts.responder({ url, init })
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	}
	const fetchImpl = spy as unknown as typeof fetch
	return { calls, fetchImpl }
}

describe('<ShowcasePage>', () => {
	test('[S1] default render — yandex channel + left iframe src', () => {
		render(<ShowcasePage />)
		const ota = screen.getByTestId('showcase-iframe-ota') as HTMLIFrameElement
		expect(ota.getAttribute('src')).toBe('/demo/ota/yandex')
		const yandexBtn = screen.getByTestId('showcase-channel-yandex')
		expect(yandexBtn.getAttribute('aria-pressed')).toBe('true')
	})

	test('[S2] switch channel to ostrovok updates left iframe src', () => {
		render(<ShowcasePage />)
		const ostrovokBtn = screen.getByTestId('showcase-channel-ostrovok')
		fireEvent.click(ostrovokBtn)
		const ota = screen.getByTestId('showcase-iframe-ota') as HTMLIFrameElement
		expect(ota.getAttribute('src')).toBe('/demo/ota/ostrovok')
		expect(ostrovokBtn.getAttribute('aria-pressed')).toBe('true')
		expect(screen.getByTestId('showcase-channel-yandex').getAttribute('aria-pressed')).toBe('false')
	})

	test('[S3] Reset button POSTs to /admin/reset and shows success banner', async () => {
		const { calls, fetchImpl } = buildFetchSpy()
		render(<ShowcasePage fetchImpl={fetchImpl} />)
		await act(async () => {
			fireEvent.click(screen.getByTestId('showcase-admin-reset'))
		})
		await waitFor(() => {
			expect(calls.length).toBe(1)
		})
		expect(calls[0]?.url).toBe('/api/_mock-ota/admin/reset')
		expect(calls[0]?.init?.method).toBe('POST')
		const banner = await screen.findByTestId('showcase-status-banner')
		expect(banner.textContent).toBe('Reset: Готово')
	})

	test('[S4] Seed button POSTs to /admin/seed and shows success banner', async () => {
		const { calls, fetchImpl } = buildFetchSpy()
		render(<ShowcasePage fetchImpl={fetchImpl} />)
		await act(async () => {
			fireEvent.click(screen.getByTestId('showcase-admin-seed'))
		})
		await waitFor(() => {
			expect(calls.length).toBe(1)
		})
		expect(calls[0]?.url).toBe('/api/_mock-ota/admin/seed')
		expect(calls[0]?.init?.method).toBe('POST')
		const banner = await screen.findByTestId('showcase-status-banner')
		expect(banner.textContent).toBe('Seed: Готово')
	})

	test('[S5] Trigger button POSTs selected scenario to /admin/trigger', async () => {
		const { calls, fetchImpl } = buildFetchSpy()
		render(<ShowcasePage fetchImpl={fetchImpl} />)

		const select = screen.getByTestId('showcase-scenario-select') as HTMLSelectElement
		fireEvent.change(select, { target: { value: 'cancel-late' } })
		expect(select.value).toBe('cancel-late')

		await act(async () => {
			fireEvent.click(screen.getByTestId('showcase-admin-trigger'))
		})
		await waitFor(() => {
			expect(calls.length).toBe(1)
		})
		expect(calls[0]?.url).toBe('/api/_mock-ota/admin/trigger')
		expect(calls[0]?.init?.method).toBe('POST')
		// Body must carry the scenario value as JSON.
		const bodyText = calls[0]?.init?.body
		expect(typeof bodyText).toBe('string')
		expect(JSON.parse(bodyText as string)).toEqual({ scenario: 'cancel-late' })
	})

	test('[S6] non-OK response surfaces в status banner as error', async () => {
		const { fetchImpl } = buildFetchSpy({
			responder: () =>
				new Response('{"error":"boom"}', {
					status: 500,
					headers: { 'content-type': 'application/json' },
				}),
		})
		render(<ShowcasePage fetchImpl={fetchImpl} />)
		await act(async () => {
			fireEvent.click(screen.getByTestId('showcase-admin-reset'))
		})
		const banner = await screen.findByTestId('showcase-status-banner')
		// Sanity: contains "ошибка" wording + the 500 status text.
		expect(banner.textContent?.startsWith('Reset — ошибка:')).toBe(true)
		expect(banner.textContent).toContain('500')
	})

	test('[S7] PMS iframe defaults to /o/demo/grid', () => {
		render(<ShowcasePage />)
		const pms = screen.getByTestId('showcase-iframe-pms') as HTMLIFrameElement
		expect(pms.getAttribute('src')).toBe('/o/demo/grid')
	})

	test('[S8] PMS iframe respects pmsGridUrl prop', () => {
		render(<ShowcasePage pmsGridUrl="/o/acme/grid" />)
		const pms = screen.getByTestId('showcase-iframe-pms') as HTMLIFrameElement
		expect(pms.getAttribute('src')).toBe('/o/acme/grid')
	})

	test('[S9] initial channel respects initialChannel prop', () => {
		render(<ShowcasePage initialChannel="ostrovok" />)
		const ota = screen.getByTestId('showcase-iframe-ota') as HTMLIFrameElement
		expect(ota.getAttribute('src')).toBe('/demo/ota/ostrovok')
	})

	test('[S10] only the active channel button is aria-pressed=true', () => {
		render(<ShowcasePage />)
		expect(screen.getByTestId('showcase-channel-yandex').getAttribute('aria-pressed')).toBe('true')
		expect(screen.getByTestId('showcase-channel-ostrovok').getAttribute('aria-pressed')).toBe(
			'false',
		)
	})
})
