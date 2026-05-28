/**
 * Round 14.6 Phase B+E.bis — per-tenant demo OTA route tests.
 *
 * Asserts:
 *   [TD1] Renders ShowcasePage с pmsGridUrl scoped к orgSlug
 *   [TD2] Onboarding hint banner appears когда user has 0 properties
 *   [TD3] Onboarding hint hidden когда properties.length > 0
 *   [TD4] Onboarding hint hidden во время loading state (no flash)
 *   [TD5] Banner dismissable — click × hides it without remounting page
 *   [TD6] Banner deep-links к `/o/$orgSlug/setup` wizard (М5c onboarding)
 *
 * Canon: `feedback_critical_fix_test_coverage` — every UX branch needs
 * test. Closes gap from Phase C self-review: magic-link redirect lands
 * here without setup → user could be stuck. Banner mitigates trap.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type * as React from 'react'

// Mock TanStack route hooks BEFORE importing the route file.
const useParamsMock = mock(() => ({ orgSlug: 'gostinitsa-romashka' }))
const useSearchMock = mock(() => ({ channel: undefined as 'yandex' | 'ostrovok' | undefined }))

mock.module('@tanstack/react-router', () => ({
	createFileRoute: () => (config: Record<string, unknown>) => ({
		useParams: () => useParamsMock(),
		useSearch: () => useSearchMock(),
		options: config,
		...config,
	}),
	Link: ({
		to,
		params,
		children,
		className,
	}: {
		to: string
		params?: Record<string, string>
		children: React.ReactNode
		className?: string
	}) => {
		const href = to.replace(/\$(\w+)/g, (_, key) => params?.[key] ?? `$${key}`)
		return (
			<a href={href} className={className} data-testid="setup-link">
				{children}
			</a>
		)
	},
}))

// Stub ShowcasePage so its iframes don't actually network. Render a
// recognizable stub div so we can assert it mounted.
mock.module('../_demo/side-by-side/showcase-page.tsx', () => ({
	ShowcasePage: ({
		initialChannel,
		pmsGridUrl,
	}: {
		initialChannel: string
		pmsGridUrl: string
	}) => (
		<div data-testid="showcase-page" data-channel={initialChannel} data-pms-url={pmsGridUrl}>
			ShowcasePage stub
		</div>
	),
}))

// propertiesQueryOptions returns a queryKey + queryFn. We don't run the
// fetch — we seed TanStack's cache directly per test.
mock.module('../features/receivables/hooks/use-receivables.ts', () => ({
	propertiesQueryOptions: {
		queryKey: ['properties'] as const,
		queryFn: async () => [],
		staleTime: 30_000,
	},
}))

const { Route } = await import('./_app.o.$orgSlug.demo')
const TenantDemoRoute = (Route as unknown as { options: { component: React.ComponentType } })
	.options.component

function renderRoute(opts: { properties?: Array<{ id: string }> | undefined } = {}) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	if (opts.properties !== undefined) {
		queryClient.setQueryData(['properties'], opts.properties)
	}
	return render(
		<QueryClientProvider client={queryClient}>
			<TenantDemoRoute />
		</QueryClientProvider>,
	)
}

afterEach(() => {
	cleanup()
	useParamsMock.mockClear()
	useSearchMock.mockClear()
	useParamsMock.mockReturnValue({ orgSlug: 'gostinitsa-romashka' })
	useSearchMock.mockReturnValue({ channel: undefined })
})

describe('TenantDemoRoute — Round 14.6 per-tenant demo OTA route', () => {
	it('[TD1] renders ShowcasePage с pmsGridUrl scoped к orgSlug', () => {
		renderRoute({ properties: [{ id: 'prop-1' }] })
		const showcase = screen.getByTestId('showcase-page')
		expect(showcase.getAttribute('data-channel')).toBe('yandex')
		expect(showcase.getAttribute('data-pms-url')).toBe('/o/gostinitsa-romashka/grid')
	})

	it('[TD1.bis] uses search.channel когда задан', () => {
		useSearchMock.mockReturnValue({ channel: 'ostrovok' })
		renderRoute({ properties: [{ id: 'prop-1' }] })
		expect(screen.getByTestId('showcase-page').getAttribute('data-channel')).toBe('ostrovok')
	})

	it('[TD2] onboarding hint banner appears когда properties.length === 0', () => {
		renderRoute({ properties: [] })
		expect(screen.queryByTestId('demo-onboarding-hint')).not.toBe(null)
	})

	it('[TD3] onboarding hint hidden когда properties.length > 0', () => {
		renderRoute({ properties: [{ id: 'prop-1' }] })
		expect(screen.queryByTestId('demo-onboarding-hint')).toBe(null)
	})

	it('[TD4] onboarding hint hidden when properties query still loading (no flash)', () => {
		// No seed → query is `pending` → undefined data
		renderRoute({})
		expect(screen.queryByTestId('demo-onboarding-hint')).toBe(null)
	})

	it('[TD5] banner dismissable — click × hides it', async () => {
		renderRoute({ properties: [] })
		expect(screen.queryByTestId('demo-onboarding-hint')).not.toBe(null)
		const dismissBtn = screen.getByLabelText('Скрыть подсказку')
		await userEvent.setup().click(dismissBtn)
		expect(screen.queryByTestId('demo-onboarding-hint')).toBe(null)
	})

	it('[TD6] banner link points к /o/$orgSlug/setup', () => {
		renderRoute({ properties: [] })
		const link = screen.getByTestId('setup-link')
		expect(link.getAttribute('href')).toBe('/o/gostinitsa-romashka/setup')
	})
})
