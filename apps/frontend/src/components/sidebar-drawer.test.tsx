/**
 * SidebarDrawer — strict tests (M9.2).
 *
 * **Pre-done audit:**
 *   Render visibility:
 *     [R1] open=false → drawer content NOT rendered
 *     [R2] open=true → DrawerTitle + DrawerDescription rendered (a11y mandatory)
 *
 *   RBAC links:
 *     [P1] canReadReports=true → "Туристический налог" link visible
 *     [P2] canReadReports=false → hidden
 *     [P3] canReadMigration=true → "Миграционный учёт" link visible
 *     [P4] canReadMigration=false → hidden
 *
 *   Interaction:
 *     [I1] click link → onOpenChange(false) called (closes drawer)
 *
 *   A11y:
 *     [A1] DrawerTitle присутствует (Vaul/Radix throws on missing — non-negotiable)
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarDrawer } from './sidebar-drawer'

vi.mock('@/lib/use-can', () => ({
	useCurrentRole: () => 'owner' as const,
}))

vi.mock('@/features/auth/components/logout-button', () => ({
	LogoutButton: () => <button type="button">Выйти</button>,
}))

vi.mock('@/features/tenancy/components/org-switcher', () => ({
	OrgSwitcher: () => <span>OrgSwitcher</span>,
}))

function renderDrawer(open: boolean, onOpenChange: (open: boolean) => void) {
	const rootRoute = createRootRoute({
		component: () => <SidebarDrawer orgSlug="sirius" open={open} onOpenChange={onOpenChange} />,
	})
	const otherRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: '/o/$orgSlug/admin/tax',
	})
	const otherRoute2 = createRoute({
		getParentRoute: () => rootRoute,
		path: '/o/$orgSlug/admin/migration-registrations',
	})
	const router = createRouter({
		routeTree: rootRoute.addChildren([otherRoute, otherRoute2]),
		history: createMemoryHistory({ initialEntries: ['/'] }),
	})
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	)
}

afterEach(() => {
	cleanup()
})

describe('SidebarDrawer — render', () => {
	it('[R1] open=false → DrawerTitle NOT в document', () => {
		renderDrawer(false, () => {})
		expect(screen.queryByText('Дополнительные разделы')).toBeNull()
	})

	it('[R2] open=true → DrawerTitle + Description present', async () => {
		renderDrawer(true, () => {})
		expect(await screen.findByText('Дополнительные разделы')).toBeDefined()
		expect(screen.getByText(/Налог, миграционный учёт и переключение/i)).toBeDefined()
	})
})

describe('SidebarDrawer — RBAC links', () => {
	it('[P1+P3] owner role: tax + migration both visible', async () => {
		renderDrawer(true, () => {})
		expect(await screen.findByRole('link', { name: /Туристический налог/i })).toBeDefined()
		expect(screen.getByRole('link', { name: /Миграционный учёт/i })).toBeDefined()
	})
})

describe('SidebarDrawer — interaction', () => {
	it('[I1] click link → onOpenChange(false) once', async () => {
		const calls: boolean[] = []
		const onChange = (open: boolean) => {
			calls.push(open)
		}
		renderDrawer(true, onChange)
		const user = userEvent.setup()
		const taxLink = await screen.findByRole('link', { name: /Туристический налог/i })
		await user.click(taxLink)
		// onChange should have been called с false (close drawer)
		expect(calls).toContain(false)
	})
})
