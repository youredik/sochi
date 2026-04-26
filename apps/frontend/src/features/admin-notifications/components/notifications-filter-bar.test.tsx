/**
 * `<NotificationsFilterBar>` strict component tests per memory
 * `feedback_strict_tests.md`. Validates onChange contract — emit shape that
 * the route file relies on for URL-state sync.
 *
 * Test plan:
 *   Recipient input — string→null mapping:
 *     [R1] empty string → onChange called with recipient: null
 *     [R2] non-empty → onChange called with recipient: <value>
 *     [R3] whitespace-only → null (trim)
 *
 *   Date inputs:
 *     [D1] empty 'from' → null
 *     [D2] valid 'from' → 'YYYY-MM-DD' string
 *     [D3] empty 'to'   → null
 *
 *   Filter shape preservation:
 *     [P1] changing recipient does NOT alter other fields
 *     [P2] changing 'from' does NOT alter status/kind/recipient/to
 *
 *   FULL enum coverage in select options:
 *     [S1] status select renders all 3 status options + "Любой"
 *     [S2] kind select renders all 7 kinds + "Любой"
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
	NotificationsFilterBar,
	type NotificationsFilterValue,
} from './notifications-filter-bar.tsx'

afterEach(cleanup)

const EMPTY: NotificationsFilterValue = {
	status: null,
	kind: null,
	recipient: null,
	from: null,
	to: null,
}

describe('NotificationsFilterBar — recipient input', () => {
	test('[R1] clearing populated input → recipient: null', () => {
		const onChange = vi.fn()
		const { getByLabelText } = render(
			<NotificationsFilterBar value={{ ...EMPTY, recipient: 'old@host' }} onChange={onChange} />,
		)
		const input = getByLabelText('Получатель') as HTMLInputElement
		fireEvent.change(input, { target: { value: '' } })
		expect(onChange).toHaveBeenCalledWith({ ...EMPTY, recipient: null })
	})

	test('[R2] non-empty → recipient: exact value (no transform)', () => {
		const onChange = vi.fn()
		const { getByLabelText } = render(<NotificationsFilterBar value={EMPTY} onChange={onChange} />)
		fireEvent.change(getByLabelText('Получатель'), {
			target: { value: 'guest@example.local' },
		})
		expect(onChange).toHaveBeenCalledWith({
			...EMPTY,
			recipient: 'guest@example.local',
		})
	})

	test('[R3] whitespace-only → null (trim)', () => {
		const onChange = vi.fn()
		const { getByLabelText } = render(
			<NotificationsFilterBar value={{ ...EMPTY, recipient: 'old@host' }} onChange={onChange} />,
		)
		fireEvent.change(getByLabelText('Получатель'), { target: { value: '   ' } })
		expect(onChange).toHaveBeenCalledWith({ ...EMPTY, recipient: null })
	})
})

describe('NotificationsFilterBar — date inputs', () => {
	test('[D1] empty "С даты" → from: null', () => {
		const onChange = vi.fn()
		const { getByLabelText } = render(
			<NotificationsFilterBar value={{ ...EMPTY, from: '2026-04-01' }} onChange={onChange} />,
		)
		fireEvent.change(getByLabelText('С даты'), { target: { value: '' } })
		expect(onChange).toHaveBeenCalledWith({ ...EMPTY, from: null })
	})

	test('[D2] valid "С даты" → from: YYYY-MM-DD', () => {
		const onChange = vi.fn()
		const { getByLabelText } = render(<NotificationsFilterBar value={EMPTY} onChange={onChange} />)
		fireEvent.change(getByLabelText('С даты'), { target: { value: '2026-05-01' } })
		expect(onChange).toHaveBeenCalledWith({ ...EMPTY, from: '2026-05-01' })
	})

	test('[D3] empty "По дату" → to: null', () => {
		const onChange = vi.fn()
		const { getByLabelText } = render(
			<NotificationsFilterBar value={{ ...EMPTY, to: '2026-04-30' }} onChange={onChange} />,
		)
		fireEvent.change(getByLabelText('По дату'), { target: { value: '' } })
		expect(onChange).toHaveBeenCalledWith({ ...EMPTY, to: null })
	})
})

describe('NotificationsFilterBar — shape preservation', () => {
	test('[P1] changing recipient preserves all other fields', () => {
		const onChange = vi.fn()
		const initial: NotificationsFilterValue = {
			status: 'failed',
			kind: 'booking_confirmed',
			recipient: 'old@host',
			from: '2026-01-01',
			to: '2026-12-31',
		}
		const { getByLabelText } = render(
			<NotificationsFilterBar value={initial} onChange={onChange} />,
		)
		fireEvent.change(getByLabelText('Получатель'), {
			target: { value: 'new@host' },
		})
		expect(onChange).toHaveBeenCalledWith({
			...initial,
			recipient: 'new@host',
		})
	})

	test('[P2] changing "С даты" preserves status/kind/recipient/to', () => {
		const onChange = vi.fn()
		const initial: NotificationsFilterValue = {
			status: 'pending',
			kind: 'payment_succeeded',
			recipient: 'a@b',
			from: null,
			to: '2026-04-30',
		}
		const { getByLabelText } = render(
			<NotificationsFilterBar value={initial} onChange={onChange} />,
		)
		fireEvent.change(getByLabelText('С даты'), { target: { value: '2026-04-01' } })
		expect(onChange).toHaveBeenCalledWith({ ...initial, from: '2026-04-01' })
	})
})
