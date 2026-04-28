/**
 * `<NotificationsTable>` strict component tests per memory
 * `feedback_strict_tests.md` + `feedback_no_halfway.md`.
 *
 * Test plan:
 *   Render correctness:
 *     [R1] empty items → EmptyState (h3 «Уведомлений нет» + description)
 *     [R2] N items → renders N <tr> rows in tbody
 *     [R3] caption sr-only present (a11y)
 *     [R4] all 6 column headers rendered with scope="col"
 *
 *   onRowClick contract:
 *     [C1] clicking a row fires onRowClick(id) with EXACT row id
 *     [C2] Enter key on focused row fires onRowClick (a11y)
 *     [C3] Space key on focused row fires onRowClick (a11y)
 *     [C4] Other keys (Tab, Esc) do NOT fire onRowClick
 *     [C5] each row has tabIndex=0 (keyboard navigable)
 *
 *   Sorting:
 *     [S1] default sort: createdAt DESC (newest first)
 *     [S2] retryCount column sortable; click toggles direction
 */
import type { Notification } from '@horeca/shared'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { NotificationsTable } from './notifications-table.tsx'

afterEach(cleanup)

function buildRow(overrides: Partial<Notification> = {}): Notification {
	return {
		tenantId: 'org-test',
		id: 'ntf_default',
		kind: 'payment_succeeded',
		channel: 'email',
		recipient: 'guest@host.local',
		recipientKind: 'guest',
		subject: 'Subject',
		bodyText: 'Body',
		payloadJson: {},
		status: 'pending',
		sentAt: null,
		failedAt: null,
		failureReason: null,
		retryCount: 0,
		sourceObjectType: 'payment',
		sourceObjectId: 'pay_01',
		sourceEventDedupKey: 'payment:pay_01:payment_succeeded',
		createdAt: '2026-04-26T10:00:00.000Z',
		updatedAt: '2026-04-26T10:00:00.000Z',
		createdBy: 'system',
		updatedBy: 'system',
		...overrides,
	}
}

describe('<NotificationsTable> — render correctness', () => {
	test('[R1] empty items → EmptyState, NO table', () => {
		const onRowClick = vi.fn()
		render(<NotificationsTable items={[]} onRowClick={onRowClick} />)
		expect(screen.getByRole('heading', { level: 3, name: 'Уведомлений нет' })).toBeDefined()
		expect(screen.getByText(/С такими фильтрами outbox пуст/)).toBeDefined()
		expect(screen.queryByRole('table')).toBeNull()
	})

	test('[R2] 3 items → 3 <tr> in tbody (header tr separate)', () => {
		const onRowClick = vi.fn()
		const items = [buildRow({ id: 'ntf_a' }), buildRow({ id: 'ntf_b' }), buildRow({ id: 'ntf_c' })]
		const { container } = render(<NotificationsTable items={items} onRowClick={onRowClick} />)
		const bodyRows = container.querySelectorAll('tbody tr')
		expect(bodyRows.length).toBe(3)
	})

	test('[R3] caption sr-only present', () => {
		const items = [buildRow()]
		const { container } = render(<NotificationsTable items={items} onRowClick={vi.fn()} />)
		const caption = container.querySelector('caption')
		expect(caption).not.toBeNull()
		expect(caption?.className).toContain('sr-only')
	})

	test('[R4] all 6 column headers rendered scope="col"', () => {
		const { container } = render(<NotificationsTable items={[buildRow()]} onRowClick={vi.fn()} />)
		const headers = container.querySelectorAll('th[scope="col"]')
		expect(headers.length).toBe(6) // Создано, Тип, Получатель, Канал, Статус, Попыток
	})
})

describe('<NotificationsTable> — onRowClick contract', () => {
	test('[C1] click row fires onRowClick(id) — exact id', () => {
		const onRowClick = vi.fn()
		const items = [buildRow({ id: 'ntf_unique_42' })]
		const { container } = render(<NotificationsTable items={items} onRowClick={onRowClick} />)
		const row = container.querySelector('tbody tr') as HTMLTableRowElement
		fireEvent.click(row)
		expect(onRowClick).toHaveBeenCalledExactlyOnceWith('ntf_unique_42')
	})

	test('[C2] Enter key on focused row fires onRowClick', () => {
		const onRowClick = vi.fn()
		const items = [buildRow({ id: 'ntf_keyed' })]
		const { container } = render(<NotificationsTable items={items} onRowClick={onRowClick} />)
		const row = container.querySelector('tbody tr') as HTMLTableRowElement
		fireEvent.keyDown(row, { key: 'Enter' })
		expect(onRowClick).toHaveBeenCalledExactlyOnceWith('ntf_keyed')
	})

	test('[C3] Space key on focused row fires onRowClick', () => {
		const onRowClick = vi.fn()
		const items = [buildRow({ id: 'ntf_space' })]
		const { container } = render(<NotificationsTable items={items} onRowClick={onRowClick} />)
		const row = container.querySelector('tbody tr') as HTMLTableRowElement
		fireEvent.keyDown(row, { key: ' ' })
		expect(onRowClick).toHaveBeenCalledExactlyOnceWith('ntf_space')
	})

	test('[C4] other keys (Tab/Escape) do NOT fire onRowClick', () => {
		const onRowClick = vi.fn()
		const { container } = render(
			<NotificationsTable items={[buildRow()]} onRowClick={onRowClick} />,
		)
		const row = container.querySelector('tbody tr') as HTMLTableRowElement
		fireEvent.keyDown(row, { key: 'Tab' })
		fireEvent.keyDown(row, { key: 'Escape' })
		fireEvent.keyDown(row, { key: 'a' })
		expect(onRowClick).not.toHaveBeenCalled()
	})

	test('[C5] every row has tabIndex=0 (keyboard navigable)', () => {
		const items = [buildRow({ id: 'a' }), buildRow({ id: 'b' })]
		const { container } = render(<NotificationsTable items={items} onRowClick={vi.fn()} />)
		const rows = container.querySelectorAll('tbody tr')
		for (const r of rows) {
			expect((r as HTMLElement).tabIndex).toBe(0)
		}
	})
})

describe('<NotificationsTable> — sorting', () => {
	test('[S1] default sort: createdAt DESC — newest first', () => {
		const onRowClick = vi.fn()
		const items = [
			buildRow({ id: 'ntf_old', createdAt: '2026-01-01T00:00:00.000Z' }),
			buildRow({ id: 'ntf_new', createdAt: '2026-04-01T00:00:00.000Z' }),
			buildRow({ id: 'ntf_mid', createdAt: '2026-02-15T00:00:00.000Z' }),
		]
		const { container } = render(<NotificationsTable items={items} onRowClick={onRowClick} />)
		const rows = container.querySelectorAll('tbody tr')
		// First row should be newest. Click it → ntf_new.
		fireEvent.click(rows[0] as HTMLElement)
		expect(onRowClick).toHaveBeenCalledWith('ntf_new')
	})

	test('[S2] retryCount column sortable: clicks toggle through asc/desc — order changes', () => {
		const items = [
			buildRow({ id: 'ntf_r0', retryCount: 0 }),
			buildRow({ id: 'ntf_r5', retryCount: 5 }),
			buildRow({ id: 'ntf_r2', retryCount: 2 }),
		]
		const onRowClick = vi.fn()
		const { container, getByRole } = render(
			<NotificationsTable items={items} onRowClick={onRowClick} />,
		)
		const sortBtn = getByRole('button', { name: /Сортировать по Попыток/ })
		// First click — sort by retryCount in ONE direction (TanStack default may
		// be asc OR desc depending on column type; we don't assert specific dir,
		// only that sort happens and toggles).
		fireEvent.click(sortBtn)
		fireEvent.click(container.querySelectorAll('tbody tr')[0] as HTMLElement)
		const firstClickResult = onRowClick.mock.calls.at(-1)?.[0] as string

		fireEvent.click(sortBtn) // toggle direction
		fireEvent.click(container.querySelectorAll('tbody tr')[0] as HTMLElement)
		const secondClickResult = onRowClick.mock.calls.at(-1)?.[0] as string

		// Different direction → different row at top.
		expect(firstClickResult).not.toBe(secondClickResult)
		// Both should be from the seeded set.
		expect(['ntf_r0', 'ntf_r2', 'ntf_r5']).toContain(firstClickResult)
		expect(['ntf_r0', 'ntf_r2', 'ntf_r5']).toContain(secondClickResult)
		// One of them must be an extreme (ntf_r0 or ntf_r5).
		expect(['ntf_r0', 'ntf_r5']).toContain(firstClickResult)
		expect(['ntf_r0', 'ntf_r5']).toContain(secondClickResult)
	})
})
