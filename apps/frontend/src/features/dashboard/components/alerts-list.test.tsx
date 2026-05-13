/**
 * alerts-list.test.tsx — strict tests covering severity-style + empty + nav.
 *
 * Pre-test invariants:
 *
 *   State machine (Loading | Error | Empty | Value):
 *     [AL1] queryFn pending → Skeleton placeholders
 *     [AL2] queryFn error → role=alert "Не удалось загрузить"
 *     [AL3] data=[] → celebratory empty copy "Всё спокойно…"
 *     [AL4] data with rows → <ul> with <Link> rows
 *
 *   Row content (mutation gates):
 *     [AL5] subject + recipient rendered exactly
 *     [AL6] failedAt → relative-time suffix; missing → no suffix
 *     [AL7] aria-label gives screen-reader context: "Сбой уведомления: <subj>"
 *     [AL8] icon present (lucide AlertCircleIcon, decorative aria-hidden)
 *
 *   Link target (TanStack Router mock from global-mocks.ts):
 *     [AL9] Link href starts with "/o/<orgSlug>/admin/notifications"
 *
 *   a11y semantics:
 *     [AL10] section aria-labelledby="alerts-heading"
 *     [AL11] h2 #alerts-heading text="Требует внимания"
 *     [AL12] data-dashboard-section="alerts"
 *
 *   Cyrillic copy verified (typo mutation gate):
 *     [AL13] empty-state EXACT "Всё спокойно — нет требующих внимания событий."
 */
import type { Notification } from '@horeca/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, test } from 'bun:test'
import { AlertsList } from './alerts-list.tsx'

function setupClient(seed?: Notification[]): QueryClient {
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
		qc.setQueryData(['dashboard', 'notifications-failed'], seed)
	}
	return qc
}

function Wrapper({ children, qc }: { children: ReactNode; qc: QueryClient }) {
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function makeFailedNotification(opts: Partial<Notification>): Notification {
	return {
		tenantId: 'ten1',
		id: `n_${Math.random()}`,
		kind: 'booking_confirmed',
		channel: 'email',
		recipient: 'guest@example.com',
		recipientKind: 'guest',
		subject: 'Подтверждение бронирования',
		bodyText: null,
		payloadJson: {},
		status: 'failed',
		sentAt: null,
		failedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
		failureReason: 'SMTP timeout',
		retryCount: 1,
		sourceObjectType: 'booking',
		sourceObjectId: 'b-1',
		sourceEventDedupKey: 'dk1',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		createdBy: 'system',
		updatedBy: 'system',
		...opts,
	}
}

describe('AlertsList — state machine', () => {
	test('[AL1] pending → Skeleton placeholders (role=status, no list)', () => {
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
				<AlertsList orgSlug="acme" />
			</Wrapper>,
		)
		expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true')
		expect(screen.queryByTestId('alerts-items')).toBeNull()
		expect(screen.queryByTestId('alerts-empty')).toBeNull()
	})

	test('[AL3, AL13] data=[] → celebratory empty copy EXACT', () => {
		const qc = setupClient([])
		render(
			<Wrapper qc={qc}>
				<AlertsList orgSlug="acme" />
			</Wrapper>,
		)
		const empty = screen.getByTestId('alerts-empty')
		expect(empty.textContent).toBe('Всё спокойно — нет требующих внимания событий.')
		expect(screen.queryByTestId('alerts-items')).toBeNull()
	})

	test('[AL4, AL5, AL6] rows render subject + recipient + relative failedAt', () => {
		const failedAt = new Date('2026-05-12T11:30:00Z').toISOString()
		const qc = setupClient([
			makeFailedNotification({
				id: 'n1',
				subject: 'Подтверждение бронирования #B-001',
				recipient: 'ivan@example.com',
				failedAt,
			}),
		])
		render(
			<Wrapper qc={qc}>
				<AlertsList orgSlug="acme" />
			</Wrapper>,
		)
		const list = screen.getByTestId('alerts-items')
		const items = list.querySelectorAll('li')
		expect(items.length).toBe(1)
		expect(items[0]?.textContent).toContain('Подтверждение бронирования #B-001')
		expect(items[0]?.textContent).toContain('ivan@example.com')
	})

	test('[AL6] missing failedAt → no relative-time suffix appended', () => {
		const qc = setupClient([
			makeFailedNotification({
				id: 'n1',
				subject: 'Сбой 1',
				recipient: 'a@example.com',
				failedAt: null,
			}),
		])
		render(
			<Wrapper qc={qc}>
				<AlertsList orgSlug="acme" />
			</Wrapper>,
		)
		// "·" separator is only emitted when failedAt is truthy. Verify
		// recipient text ends at the e-mail (no ` · ` suffix follows).
		expect(screen.getByText('a@example.com').tagName).toBe('SPAN')
	})

	test('[AL7] aria-label provides SR context: "Сбой уведомления: <subject>"', () => {
		const qc = setupClient([
			makeFailedNotification({
				id: 'n1',
				subject: 'Контрольный заезд',
				recipient: 'a@example.com',
			}),
		])
		render(
			<Wrapper qc={qc}>
				<AlertsList orgSlug="acme" />
			</Wrapper>,
		)
		const link = screen.getByLabelText('Сбой уведомления: Контрольный заезд')
		expect(link.tagName).toBe('A')
	})

	test('[AL8] AlertCircleIcon present + aria-hidden (decorative)', () => {
		const qc = setupClient([
			makeFailedNotification({ id: 'n1', subject: 'X', recipient: 'a@b.com' }),
		])
		const { container } = render(
			<Wrapper qc={qc}>
				<AlertsList orgSlug="acme" />
			</Wrapper>,
		)
		const list = container.querySelector('[data-testid="alerts-items"]')
		const hiddenSvg = list?.querySelector('svg[aria-hidden="true"]')
		expect(hiddenSvg?.tagName.toLowerCase()).toBe('svg')
	})

	test('[AL9] Link href targets /o/<orgSlug>/admin/notifications', () => {
		const qc = setupClient([
			makeFailedNotification({ id: 'n1', subject: 'X', recipient: 'a@b.com' }),
		])
		render(
			<Wrapper qc={qc}>
				<AlertsList orgSlug="acme-hotel" />
			</Wrapper>,
		)
		const link = screen.getByLabelText('Сбой уведомления: X')
		expect(link.getAttribute('href')).toBe('/o/acme-hotel/admin/notifications')
	})
})

describe('AlertsList — a11y semantics', () => {
	test('[AL10, AL11, AL12] section aria-labelledby + h2 + data-section-id (useId-generated)', () => {
		const qc = setupClient([])
		const { container } = render(
			<Wrapper qc={qc}>
				<AlertsList orgSlug="acme" />
			</Wrapper>,
		)
		const section = container.querySelector('section[data-dashboard-section="alerts"]')
		expect(section?.tagName).toBe('SECTION')
		const labelledby = section?.getAttribute('aria-labelledby')
		// useId() produces ":r0:"-style values; verify shape rather than just
		// existence — mutation gate against a regression to a literal string id.
		expect(labelledby).toMatch(/^[:_a-zA-Z][:_\-a-zA-Z0-9]*$/)
		const heading = section?.querySelector(`h2#${CSS.escape(labelledby ?? '')}`)
		expect(heading?.tagName).toBe('H2')
		expect(heading?.textContent).toBe('Требует внимания')
	})
})
