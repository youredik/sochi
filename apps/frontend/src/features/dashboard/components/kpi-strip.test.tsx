/**
 * kpi-strip.test.tsx — strict RBAC × state matrix.
 *
 * Pre-test invariants:
 *
 *   RBAC × roles (enum FULL coverage, NOT representative):
 *     [R1] role='owner'   → 4 cards visible (arrivals + in-house + balance + failed)
 *     [R2] role='manager' → 4 cards visible (same as owner per rbac.ts)
 *     [R3] role='staff'   → 2 cards visible (arrivals + in-house only; staff
 *          lacks report:read + notification:read)
 *     [R4] role=undefined (loading) → 0 cards (deny-by-default)
 *
 *   State propagation (Loading → Error → Value):
 *     [S1] All queries pending → all visible cards show loading state
 *     [S2] bookings error → arrivals + in-house cards show error
 *          (independent: receivables success doesn't mask bookings error)
 *     [S3] All success → arrivals/in-house compute from bookings data,
 *          balance from receivables, failed from notifications
 *
 *   Аria-label section:
 *     [A1] section element has aria-label="Ключевые показатели"
 *     [A2] data-dashboard-section="kpi-strip" for e2e selectors
 *
 *   Mutation gates:
 *     [M1] arrivals count uses TODAY (mock todayInMoscow → "2026-05-12")
 *          — checkIn===today filter actually filters
 *     [M2] balance value uses formatMoney (NBSP+₽), NOT raw string
 */
import type { Booking, Folio, Notification } from '@horeca/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import * as computeKpis from '../lib/compute-kpis.ts'
import { KpiStrip } from './kpi-strip.tsx'

// Pin "today" so arrival filtering is deterministic across CI TZ.
vi.spyOn(computeKpis, 'todayInMoscow').mockReturnValue('2026-05-12')

// Build a QueryClient with seeded data + flags that prevent the underlying
// queryFn from firing. Without `staleTime: Infinity` + `refetchOnMount: false`
// happy-dom would launch the queryFn (real fetch) on mount → AbortError on
// test teardown. Per stankoff `2afcef0` canonical pattern.
function setupClient(opts: {
	bookings?: Booking[]
	receivables?: Folio[]
	failed?: Notification[]
}): QueryClient {
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
	const propertyId = 'prop-test'
	if (opts.bookings !== undefined) {
		qc.setQueryData(['dashboard', 'bookings-window', { propertyId }], opts.bookings)
	}
	if (opts.receivables !== undefined) {
		qc.setQueryData(['receivables', { propertyId }], opts.receivables)
	}
	if (opts.failed !== undefined) {
		qc.setQueryData(['dashboard', 'notifications-failed'], opts.failed)
	}
	return qc
}

function Wrapper({ children, qc }: { children: ReactNode; qc: QueryClient }) {
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function makeBooking(opts: Partial<Booking>): Booking {
	return {
		checkIn: '2026-05-12',
		status: 'confirmed',
		...opts,
	} as Booking
}

describe('KpiStrip — RBAC × visibility (enum FULL coverage)', () => {
	test('[R1] owner sees all 4 cards', () => {
		const qc = setupClient({
			bookings: [makeBooking({})],
			receivables: [],
			failed: [],
		})
		render(
			<Wrapper qc={qc}>
				<KpiStrip memberRole="owner" propertyId="prop-test" />
			</Wrapper>,
		)
		expect(screen.getByTestId('kpi-card-arrivals-today').getAttribute('data-slot')).toBe('card')
		expect(screen.getByTestId('kpi-card-in-house').getAttribute('data-slot')).toBe('card')
		expect(screen.getByTestId('kpi-card-open-balance').getAttribute('data-slot')).toBe('card')
		expect(screen.getByTestId('kpi-card-failed-notifications').getAttribute('data-slot')).toBe(
			'card',
		)
	})

	test('[R2] manager sees all 4 cards (same RBAC as owner для report+notification:read)', () => {
		const qc = setupClient({
			bookings: [makeBooking({})],
			receivables: [],
			failed: [],
		})
		render(
			<Wrapper qc={qc}>
				<KpiStrip memberRole="manager" propertyId="prop-test" />
			</Wrapper>,
		)
		expect(screen.getByTestId('kpi-card-arrivals-today').getAttribute('data-slot')).toBe('card')
		expect(screen.getByTestId('kpi-card-in-house').getAttribute('data-slot')).toBe('card')
		expect(screen.getByTestId('kpi-card-open-balance').getAttribute('data-slot')).toBe('card')
		expect(screen.getByTestId('kpi-card-failed-notifications').getAttribute('data-slot')).toBe(
			'card',
		)
	})

	test('[R3] staff sees EXACTLY 2 cards (booking-related only, no balance/failed)', () => {
		const qc = setupClient({
			bookings: [makeBooking({})],
			receivables: [],
			failed: [],
		})
		render(
			<Wrapper qc={qc}>
				<KpiStrip memberRole="staff" propertyId="prop-test" />
			</Wrapper>,
		)
		expect(screen.getByTestId('kpi-card-arrivals-today').getAttribute('data-slot')).toBe('card')
		expect(screen.getByTestId('kpi-card-in-house').getAttribute('data-slot')).toBe('card')
		// Mutation gate: these must NOT render для staff.
		expect(screen.queryByTestId('kpi-card-open-balance')).toBeNull()
		expect(screen.queryByTestId('kpi-card-failed-notifications')).toBeNull()
	})

	test('[R4] role=undefined (loading) → 0 cards (deny-by-default)', () => {
		const qc = setupClient({
			bookings: [makeBooking({})],
			receivables: [],
			failed: [],
		})
		render(
			<Wrapper qc={qc}>
				<KpiStrip memberRole={undefined} propertyId="prop-test" />
			</Wrapper>,
		)
		expect(screen.queryByTestId('kpi-card-arrivals-today')).toBeNull()
		expect(screen.queryByTestId('kpi-card-in-house')).toBeNull()
		expect(screen.queryByTestId('kpi-card-open-balance')).toBeNull()
		expect(screen.queryByTestId('kpi-card-failed-notifications')).toBeNull()
	})
})

describe('KpiStrip — state derivation per card', () => {
	test('[S1] all queries pending → all cards loading state', () => {
		// Fresh QueryClient with NO seed data → all queries start in pending
		// state. `refetchOnMount: false` ensures no queryFn fires during the
		// test render (would otherwise trigger happy-dom fetch + teardown abort).
		const qc = new QueryClient({
			defaultOptions: {
				queries: {
					retry: false,
					refetchOnMount: false,
					refetchOnWindowFocus: false,
					refetchInterval: false,
				},
			},
		})
		render(
			<Wrapper qc={qc}>
				<KpiStrip memberRole="owner" propertyId="prop-test" />
			</Wrapper>,
		)
		expect(screen.getByTestId('kpi-card-arrivals-today').getAttribute('data-state')).toBe('loading')
		expect(screen.getByTestId('kpi-card-in-house').getAttribute('data-state')).toBe('loading')
		expect(screen.getByTestId('kpi-card-open-balance').getAttribute('data-state')).toBe('loading')
		expect(screen.getByTestId('kpi-card-failed-notifications').getAttribute('data-state')).toBe(
			'loading',
		)
	})

	test('[S3, M1] arrivals counts checkIn===today + status canon, in-house counts status=in_house', () => {
		const qc = setupClient({
			bookings: [
				makeBooking({ checkIn: '2026-05-12', status: 'confirmed' }), // arrival
				makeBooking({ checkIn: '2026-05-12', status: 'in_house' }), // arrival + in_house
				makeBooking({ checkIn: '2026-05-12', status: 'cancelled' }), // excluded
				makeBooking({ checkIn: '2026-05-10', status: 'in_house' }), // in_house, not arrival
				makeBooking({ checkIn: '2026-05-15', status: 'confirmed' }), // future
			],
			receivables: [],
			failed: [],
		})
		render(
			<Wrapper qc={qc}>
				<KpiStrip memberRole="owner" propertyId="prop-test" />
			</Wrapper>,
		)
		// Scope per-card to avoid cross-card text collision (both compute to 2).
		const arrivalsCard = screen.getByTestId('kpi-card-arrivals-today')
		const inHouseCard = screen.getByTestId('kpi-card-in-house')
		expect(arrivalsCard.getAttribute('data-state')).toBe('value')
		expect(inHouseCard.getAttribute('data-state')).toBe('value')
		const arrivalsNumber = arrivalsCard.querySelector('span.tabular-nums')
		const inHouseNumber = inHouseCard.querySelector('span.tabular-nums')
		expect(arrivalsNumber?.textContent).toBe('2')
		expect(inHouseNumber?.textContent).toBe('2')
	})

	test('[S3, M2] open balance renders formatMoney output (NBSP+₽, RU canonical)', () => {
		const NBSP = ' '
		const qc = setupClient({
			bookings: [],
			receivables: [{ balanceMinor: '150000' } as Folio, { balanceMinor: '50000' } as Folio],
			failed: [],
		})
		render(
			<Wrapper qc={qc}>
				<KpiStrip memberRole="owner" propertyId="prop-test" />
			</Wrapper>,
		)
		// 200_000 kop = 2 000 RUB → "2 000,00 ₽". testing-library normalizes
		// NBSP→space in matchers, so we read textContent directly (raw,
		// unnormalized — preserves the NBSP gotcha verification).
		const balanceCard = screen.getByTestId('kpi-card-open-balance')
		const valueNode = balanceCard.querySelector('span.tabular-nums')
		expect(valueNode?.textContent).toBe(`2${NBSP}000,00${NBSP}₽`)
		const srNode = balanceCard.querySelector('.sr-only')
		expect(srNode?.textContent).toBe('2000 рублей 0 копеек')
	})

	test('[S3] failed notifications count → exact number from query data', () => {
		const qc = setupClient({
			bookings: [],
			receivables: [],
			failed: [
				{ status: 'failed' } as Notification,
				{ status: 'failed' } as Notification,
				{ status: 'failed' } as Notification,
			],
		})
		render(
			<Wrapper qc={qc}>
				<KpiStrip memberRole="owner" propertyId="prop-test" />
			</Wrapper>,
		)
		const failedCard = screen.getByTestId('kpi-card-failed-notifications')
		expect(failedCard.getAttribute('data-state')).toBe('value')
		expect(failedCard.textContent).toContain('3')
	})
})

describe('KpiStrip — section semantics', () => {
	test('[A1, A2] section has aria-label + data-dashboard-section', () => {
		const qc = setupClient({ bookings: [], receivables: [], failed: [] })
		const { container } = render(
			<Wrapper qc={qc}>
				<KpiStrip memberRole="owner" propertyId="prop-test" />
			</Wrapper>,
		)
		const section = container.querySelector('section[aria-label="Ключевые показатели"]')
		// `data-dashboard-section` (NOT `data-section-id`) — the sidebar uses
		// `data-section-id` for its 7 nav rows, so dashboard sections live in a
		// distinct namespace to avoid e2e selector collisions per A.bis.3 fix.
		expect(section?.getAttribute('data-dashboard-section')).toBe('kpi-strip')
	})
})
