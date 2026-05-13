/**
 * recent-activity-list.test.tsx — strict (per `feedback_strict_tests.md`).
 *
 * Pre-test invariants:
 *
 *   State machine (Loading | Error | Empty | Value):
 *     [L1] queryFn pending → Skeleton row placeholders rendered, no list
 *     [L2] queryFn error → role=alert with RU "Не удалось загрузить"
 *     [L3] data=[] → empty-state copy "Активности пока нет…"
 *     [L4] data with rows → <ul> с описаниями + relative time per row
 *
 *   Row composition (mutation gates):
 *     [L5] objectType=booking + activityType=created → "Создано бронирование"
 *     [L6] objectType=folio + activityType=statusChange → "Сменён статус: счёт"
 *     [L7] each row has <time dateTime={createdAt}> (a11y navigation)
 *
 *   List semantics (a11y):
 *     [L8] section aria-labelledby="recent-activity-heading"
 *     [L9] h2 with id="recent-activity-heading" text="Недавние события"
 *     [L10] data-dashboard-section="recent-activity" для e2e selectors
 *
 *   Cyrillic glance copy verified:
 *     [L11] empty-state EXACT match (mutation gate against typo drift)
 */
import type { Activity } from '@horeca/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, test } from 'bun:test'
import { RecentActivityList } from './recent-activity-list.tsx'

function setupClient(seed?: Activity[]): QueryClient {
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
	if (seed !== undefined) {
		qc.setQueryData(['dashboard', 'activity-recent', { limit: 20 }], seed)
	}
	return qc
}

function Wrapper({ children, qc }: { children: ReactNode; qc: QueryClient }) {
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function makeActivity(opts: Partial<Activity>): Activity {
	return {
		tenantId: 'ten1',
		objectType: 'booking',
		recordId: 'b-1',
		createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
		id: `act_${Math.random()}`,
		activityType: 'created',
		actorType: 'user',
		actorUserId: 'u1',
		impersonatorUserId: null,
		diffJson: {},
		...opts,
	}
}

describe('RecentActivityList — state machine', () => {
	test('[L1] pending → Skeleton placeholders rendered (role=status, no list)', () => {
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
				<RecentActivityList />
			</Wrapper>,
		)
		const status = screen.getByRole('status')
		expect(status.getAttribute('aria-busy')).toBe('true')
		expect(within(status).getByText('Загрузка').className).toContain('sr-only')
		expect(screen.queryByTestId('recent-activity-items')).toBeNull()
		expect(screen.queryByTestId('recent-activity-empty')).toBeNull()
	})

	test('[L3] data=[] → empty-state celebratory copy', () => {
		const qc = setupClient([])
		render(
			<Wrapper qc={qc}>
				<RecentActivityList />
			</Wrapper>,
		)
		const empty = screen.getByTestId('recent-activity-empty')
		expect(empty.textContent).toBe(
			'Активности пока нет — здесь появятся события по бронированиям, платежам и уведомлениям.',
		)
		expect(screen.queryByTestId('recent-activity-items')).toBeNull()
		expect(screen.queryByRole('alert')).toBeNull()
	})

	test('[L4, L5, L6, L7] rows render with verb+noun + dateTime time element', () => {
		const now = new Date('2026-05-12T12:00:00Z')
		const t1 = new Date('2026-05-12T11:55:00Z').toISOString() // 5 min ago
		const t2 = new Date('2026-05-12T11:00:00Z').toISOString() // 1 hr ago
		const qc = setupClient([
			makeActivity({
				id: 'a1',
				objectType: 'booking',
				activityType: 'created',
				createdAt: t1,
			}),
			makeActivity({
				id: 'a2',
				objectType: 'folio',
				activityType: 'statusChange',
				createdAt: t2,
			}),
		])
		render(
			<Wrapper qc={qc}>
				<RecentActivityList />
			</Wrapper>,
		)
		// [L4] list mount
		const list = screen.getByTestId('recent-activity-items')
		const items = list.querySelectorAll('li')
		expect(items.length).toBe(2)
		// [L5] composition first row
		expect(items[0]?.textContent).toContain('Создано бронирование')
		// [L6] composition second row
		expect(items[1]?.textContent).toContain('Сменён статус: счёт')
		// [L7] <time dateTime> on each row
		const times = list.querySelectorAll('time[dateTime]')
		expect(times.length).toBe(2)
		expect(times[0]?.getAttribute('dateTime')).toBe(t1)
		expect(times[1]?.getAttribute('dateTime')).toBe(t2)
		// Mutation gate: ensure relative time string is non-empty + Cyrillic.
		expect(times[0]?.textContent ?? '').toMatch(/[а-я]/i)
		void now // keep var alive for grep clarity
	})
})

describe('RecentActivityList — a11y semantics', () => {
	test('[L8, L9, L10] section aria-labelledby + h2 heading + data-section-id (useId-generated)', () => {
		const qc = setupClient([])
		const { container } = render(
			<Wrapper qc={qc}>
				<RecentActivityList />
			</Wrapper>,
		)
		const section = container.querySelector('section[data-dashboard-section="recent-activity"]')
		expect(section?.tagName).toBe('SECTION')
		// `useId()` produces ":r0:"-style runtime ids — assert linkage via
		// aria-labelledby ↔ id correspondence + shape, NOT existence-only.
		const labelledby = section?.getAttribute('aria-labelledby')
		expect(labelledby).toMatch(/^[:_a-zA-Z][:_\-a-zA-Z0-9]*$/)
		const heading = section?.querySelector(`h2#${CSS.escape(labelledby ?? '')}`)
		expect(heading?.tagName).toBe('H2')
		expect(heading?.textContent).toBe('Недавние события')
	})

	test('[L11] empty-state copy is EXACT Cyrillic match (mutation gate)', () => {
		const qc = setupClient([])
		render(
			<Wrapper qc={qc}>
				<RecentActivityList />
			</Wrapper>,
		)
		// Same exact string as canonical CONSTANT в component module — typo
		// would break this assertion. Pure mutation gate.
		const empty = screen.getByTestId('recent-activity-empty')
		expect(empty.textContent).toBe(
			'Активности пока нет — здесь появятся события по бронированиям, платежам и уведомлениям.',
		)
	})
})
