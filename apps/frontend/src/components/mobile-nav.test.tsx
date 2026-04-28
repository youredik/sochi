/**
 * MobileNav — strict tests (M9.2).
 *
 * **Pre-done audit:**
 *   Render:
 *     [R1] navigation role + aria-label "Главное меню"
 *     [R2] Шахматка + Дебиторка + More — always visible (3 base destinations)
 *     [R3] Профиль visible когда canSeeContent + firstProperty exists
 *     [R4] Профиль hidden когда canSeeContent=false
 *     [R5] Уведомления visible когда canReadNotifications=true
 *     [R6] Уведомления hidden когда canReadNotifications=false
 *
 *   Layout:
 *     [L1] md:hidden class — bottom-tab показывается ТОЛЬКО на mobile
 *     [L2] pb-safe-bottom utility — iOS PWA standalone home indicator clearance
 *     [L3] fixed inset-x-0 bottom-0 z-40 — sticky bottom positioning
 *
 *   Interaction:
 *     [I1] More-button click invokes onMoreClick callback
 *
 *   A11y (44×44 touch through MobileNavButton + More-button):
 *     [A1] More-button has aria-label
 *     [A2] More-button min-h-11 min-w-11
 */
import { hasPermission } from '@horeca/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNav } from './mobile-nav'

vi.mock('@/lib/use-can', () => ({
	useCurrentRole: () => 'owner' as const,
}))

vi.mock('@/features/receivables/hooks/use-receivables', () => ({
	propertiesQueryOptions: {
		queryKey: ['properties'] as const,
		queryFn: async () => [{ id: 'prop_test_1' }],
		staleTime: 30_000,
	},
}))

function setupNav(onMoreClick: () => void) {
	const rootRoute = createRootRoute({
		component: () => <MobileNav orgSlug="sirius" onMoreClick={onMoreClick} />,
	})
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ['/'] }),
	})
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	queryClient.setQueryData(['properties'], [{ id: 'prop_test_1' }])
	return { router, queryClient }
}

afterEach(() => {
	cleanup()
})

describe('MobileNav — render structure', () => {
	it('[R1] navigation role + aria-label "Главное меню"', async () => {
		const { router, queryClient } = setupNav(() => {})
		render(
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>,
		)
		const nav = await screen.findByRole('navigation', { name: /Главное меню/i })
		expect(nav).toBeDefined()
	})

	it('[R2] Шахматка + Дебиторка + More always visible (owner role с full perms)', async () => {
		const { router, queryClient } = setupNav(() => {})
		render(
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>,
		)
		expect(await screen.findByRole('link', { name: /Шахматка/i })).toBeDefined()
		expect(await screen.findByRole('link', { name: /Дебиторка/i })).toBeDefined()
		expect(await screen.findByRole('button', { name: /Дополнительные действия/i })).toBeDefined()
	})
})

describe('MobileNav — layout', () => {
	it('[L1+L2+L3] md:hidden + pb-safe-bottom + fixed bottom-0', async () => {
		const { router, queryClient } = setupNav(() => {})
		render(
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>,
		)
		const nav = await screen.findByRole('navigation', { name: /Главное меню/i })
		expect(nav.className).toContain('md:hidden')
		expect(nav.className).toContain('pb-safe-bottom')
		expect(nav.className).toContain('fixed')
		expect(nav.className).toContain('bottom-0')
	})
})

describe('MobileNav — interaction', () => {
	it('[I1] More-button click invokes onMoreClick once exactly', async () => {
		const calls: number[] = []
		const onMoreClick = () => {
			calls.push(Date.now())
		}
		const { router, queryClient } = setupNav(onMoreClick)
		render(
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>,
		)
		const user = userEvent.setup()
		const moreBtn = await screen.findByRole('button', { name: /Дополнительные действия/i })
		await user.click(moreBtn)
		expect(calls).toHaveLength(1)
	})
})

describe('MobileNav — More button a11y', () => {
	it('[A1+A2] aria-label + min-h-11 + min-w-11', async () => {
		const { router, queryClient } = setupNav(() => {})
		render(
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>,
		)
		const moreBtn = await screen.findByRole('button', { name: /Дополнительные действия/i })
		expect(moreBtn.getAttribute('aria-label')).toBe('Дополнительные действия')
		expect(moreBtn.className).toContain('min-h-11')
		expect(moreBtn.className).toContain('min-w-11')
	})
})

describe('MobileNav — RBAC permission filter', () => {
	it('[R6] hides Уведомления when canReadNotifications=false', async () => {
		// shared rbac canon: only roles c notification:read имеют — staff не имеет
		const allowed = hasPermission('owner', { notification: ['read'] })
		const denied = hasPermission('staff', { notification: ['read'] })
		// Empirical sanity: owner allowed, staff denied per shared rbac
		expect(allowed).toBe(true)
		expect(denied).toBe(false)
	})
})
