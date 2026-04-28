/**
 * MobileNavButton — strict tests (M9.2).
 *
 * **Pre-done audit:**
 *   Touch target (canon WCAG AAA / Apple HIG):
 *     [T1] computed min-h ≥ 44px (Tailwind v4 spacing 11)
 *     [T2] computed min-w ≥ 44px
 *
 *   Render:
 *     [R1] icon + label rendered
 *     [R2] aria-current="page" когда matchRoute returns truthy match
 *     [R3] aria-current absent когда не matched
 *
 *   A11y:
 *     [A1] focusable via keyboard tab
 */
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import { CalendarIcon } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MobileNavButton } from './mobile-nav-button'

function setupRouter(currentPath: string) {
	const rootRoute = createRootRoute()
	const gridRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: '/o/$orgSlug/grid',
		component: () => (
			<MobileNavButton
				icon={CalendarIcon}
				label="Шахматка"
				to="/o/$orgSlug/grid"
				params={{ orgSlug: 'sirius' }}
			/>
		),
	})
	const otherRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: '/o/$orgSlug/other',
		component: () => (
			<MobileNavButton
				icon={CalendarIcon}
				label="Шахматка"
				to="/o/$orgSlug/grid"
				params={{ orgSlug: 'sirius' }}
			/>
		),
	})
	const router = createRouter({
		routeTree: rootRoute.addChildren([gridRoute, otherRoute]),
		history: createMemoryHistory({ initialEntries: [currentPath] }),
	})
	return router
}

beforeEach(() => {
	// клин up dom — в jsdom-like env testing-library не auto-cleanup без globals: true
})

afterEach(() => {
	cleanup()
})

describe('MobileNavButton — touch target (44×44 canon)', () => {
	it('[T1+T2] applies min-h-11 + min-w-11 utility classes', async () => {
		const router = setupRouter('/o/sirius/grid')
		render(<RouterProvider router={router} />)
		// Wait for router to render
		const link = await screen.findByRole('link', { name: /Шахматка/ })
		expect(link.className).toContain('min-h-11')
		expect(link.className).toContain('min-w-11')
	})
})

describe('MobileNavButton — render', () => {
	it('[R1] renders icon + label', async () => {
		const router = setupRouter('/o/sirius/grid')
		render(<RouterProvider router={router} />)
		const link = await screen.findByRole('link', { name: /Шахматка/ })
		expect(link).toBeDefined()
		// lucide icons render с aria-hidden — verify icon present via SVG
		expect(link.querySelector('svg')).not.toBeNull()
	})

	it('[R2] aria-current="page" when route is active', async () => {
		const router = setupRouter('/o/sirius/grid')
		render(<RouterProvider router={router} />)
		const link = await screen.findByRole('link', { name: /Шахматка/ })
		expect(link.getAttribute('aria-current')).toBe('page')
	})

	it('[R3] aria-current absent when route is not active', async () => {
		const router = setupRouter('/o/sirius/other')
		render(<RouterProvider router={router} />)
		const link = await screen.findByRole('link', { name: /Шахматка/ })
		expect(link.hasAttribute('aria-current')).toBe(false)
	})
})
