/**
 * dashboard-page.test.tsx — composition + RBAC regression tests.
 *
 * Pre-test invariants:
 *
 *   Structure (every role):
 *     [DP1] h1 contains organizationName
 *     [DP2] <main> root rendered
 *     [DP3] RecentActivityList mounted
 *
 *   KPI strip gating on propertyId:
 *     [DP4] propertyId=undefined → "Подождите, загружаем…" fallback,
 *           NO kpi-strip rendered (mutation gate: KpiStrip needs propertyId)
 *     [DP5] propertyId provided → kpi-strip section rendered
 *
 *   Alerts visibility per role (RBAC enum FULL):
 *     [DP6] role=owner   → AlertsList mounted, lg:col-span-2 на activity
 *     [DP7] role=manager → AlertsList mounted
 *     [DP8] role=staff   → NO AlertsList (no notification:read), activity
 *           takes col-span-3 (full width)
 *     [DP9] role=undefined → NO AlertsList (deny-by-default)
 *
 *   Sidebar nav role check:
 *     [DP10] NO `<a>` tile to /grid /receivables /tax /notifications в этой странице
 *           (those moved to sidebar at A.bis.2; dashboard NOT a nav-хаб)
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, test } from 'vitest'
import { DashboardPage } from './dashboard-page.tsx'

function setupClient(): QueryClient {
	const qc = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
				staleTime: Number.POSITIVE_INFINITY,
				refetchOnMount: false,
				refetchOnWindowFocus: false,
				refetchInterval: false,
			},
		},
	})
	// Seed empty arrays so KpiStrip + lists land in "value+empty" state, not
	// pending — keeps tests focused on composition, not loading UI.
	qc.setQueryData(['dashboard', 'bookings-window', { propertyId: 'prop-1' }], [])
	qc.setQueryData(['receivables', { propertyId: 'prop-1' }], [])
	qc.setQueryData(['dashboard', 'notifications-failed'], [])
	qc.setQueryData(['dashboard', 'activity-recent', { limit: 20 }], [])
	return qc
}

function Wrapper({ children, qc }: { children: ReactNode; qc: QueryClient }) {
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('DashboardPage — structure', () => {
	test('[DP1, DP2, DP3] h1 + <main> + RecentActivity mounted', () => {
		const qc = setupClient()
		const { container } = render(
			<Wrapper qc={qc}>
				<DashboardPage
					organizationName="Гостиница Сириус"
					orgSlug="sirius"
					memberRole="owner"
					propertyId="prop-1"
				/>
			</Wrapper>,
		)
		expect(container.querySelector('main')?.tagName).toBe('MAIN')
		expect(screen.getByText('Гостиница Сириус').tagName).toBe('H1')
		expect(container.querySelector('[data-dashboard-section="recent-activity"]')?.tagName).toBe(
			'SECTION',
		)
	})
})

describe('DashboardPage — KPI strip gating on propertyId', () => {
	test('[DP4] propertyId=undefined → fallback message, no kpi-strip', () => {
		const qc = setupClient()
		const { container } = render(
			<Wrapper qc={qc}>
				<DashboardPage organizationName="X" orgSlug="x" memberRole="owner" propertyId={undefined} />
			</Wrapper>,
		)
		expect(screen.getByTestId('dashboard-no-property').textContent).toContain(
			'Подождите, загружаем данные гостиницы…',
		)
		expect(container.querySelector('[data-dashboard-section="kpi-strip"]')).toBeNull()
	})

	test('[DP5] propertyId provided → kpi-strip section rendered', () => {
		const qc = setupClient()
		const { container } = render(
			<Wrapper qc={qc}>
				<DashboardPage organizationName="X" orgSlug="x" memberRole="owner" propertyId="prop-1" />
			</Wrapper>,
		)
		expect(container.querySelector('[data-dashboard-section="kpi-strip"]')?.tagName).toBe('SECTION')
		expect(screen.queryByTestId('dashboard-no-property')).toBeNull()
	})
})

describe('DashboardPage — RBAC × AlertsList visibility', () => {
	test('[DP6] owner → AlertsList mounted', () => {
		const qc = setupClient()
		const { container } = render(
			<Wrapper qc={qc}>
				<DashboardPage organizationName="X" orgSlug="x" memberRole="owner" propertyId="prop-1" />
			</Wrapper>,
		)
		expect(container.querySelector('[data-dashboard-section="alerts"]')?.tagName).toBe('SECTION')
	})

	test('[DP7] manager → AlertsList mounted', () => {
		const qc = setupClient()
		const { container } = render(
			<Wrapper qc={qc}>
				<DashboardPage organizationName="X" orgSlug="x" memberRole="manager" propertyId="prop-1" />
			</Wrapper>,
		)
		expect(container.querySelector('[data-dashboard-section="alerts"]')?.tagName).toBe('SECTION')
	})

	test('[DP8] staff → NO AlertsList (no notification:read)', () => {
		const qc = setupClient()
		const { container } = render(
			<Wrapper qc={qc}>
				<DashboardPage organizationName="X" orgSlug="x" memberRole="staff" propertyId="prop-1" />
			</Wrapper>,
		)
		expect(container.querySelector('[data-dashboard-section="alerts"]')).toBeNull()
	})

	test('[DP9] role=undefined → NO AlertsList (deny-by-default)', () => {
		const qc = setupClient()
		const { container } = render(
			<Wrapper qc={qc}>
				<DashboardPage
					organizationName="X"
					orgSlug="x"
					memberRole={undefined}
					propertyId="prop-1"
				/>
			</Wrapper>,
		)
		expect(container.querySelector('[data-dashboard-section="alerts"]')).toBeNull()
	})
})

describe('DashboardPage — NOT a nav-хаб (sidebar owns nav)', () => {
	test('[DP10] no nav-tile links to /grid /receivables /tax /notifications in page body', () => {
		const qc = setupClient()
		const { container } = render(
			<Wrapper qc={qc}>
				<DashboardPage organizationName="X" orgSlug="acme" memberRole="owner" propertyId="prop-1" />
			</Wrapper>,
		)
		// Mutation gate: the legacy nav tiles would render links to these
		// paths. They MUST NOT appear in the new dashboard body.
		const links = Array.from(container.querySelectorAll('a[href]'))
		const navTilePaths = ['/o/acme/grid', '/o/acme/receivables', '/o/acme/admin/tax']
		for (const path of navTilePaths) {
			const found = links.find((a) => a.getAttribute('href') === path)
			expect(found).toBeUndefined()
		}
		// AlertsList does link to /admin/notifications — that's expected (it's
		// the drill-down for a failed-row click, not a nav tile). Empty data
		// means no rows currently, so even that link is absent here.
	})
})
