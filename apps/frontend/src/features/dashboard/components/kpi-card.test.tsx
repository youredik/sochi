/**
 * kpi-card.test.tsx — strict (per `feedback_strict_tests.md`).
 *
 * Pre-test invariants:
 *
 *   State machine: Loading | Error | Value (exhaustive enum coverage):
 *     [K1] state=loading → Skeleton visible, no value text, role="status"
 *          + aria-busy="true" + sr-only «Загрузка»
 *     [K2] state=error → role="alert" + message text + aria-live="assertive"
 *     [K3] state=value → number visible, tabular-nums class present, no
 *          Skeleton, no error
 *
 *   data-state attribute reflects current kind (mutation gate):
 *     [K4] loading kind → data-state="loading" on root
 *     [K5] error kind → data-state="error"
 *     [K6] value kind → data-state="value"
 *
 *   ariaValue secondary expansion (sr-only):
 *     [K7] value provided with ariaValue → both render, ariaValue в .sr-only
 *     [K8] value provided without ariaValue → no .sr-only sibling rendered
 *
 *   Cyrillic label rendered as-is:
 *     [K9] title="В отеле сейчас" → exact text matches
 *
 *   Zero-state muted styling:
 *     [K10] value="0" → text-muted-foreground class (visual "no data" hint)
 *     [K11] value="0 ₽" → same muted treatment
 *     [K12] value="5" → NOT muted (real data is full opacity)
 *
 *   Footnote optional:
 *     [K13] footnote provided → rendered as <p>
 *     [K14] footnote omitted → no extra <p> below value
 *
 *   data-testid present для downstream e2e selectors:
 *     [K15] data-testid="kpi-card-<id>" on root
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, test } from 'bun:test'
import { KpiCard } from './kpi-card.tsx'

describe('KpiCard — Loading state', () => {
	test('[K1, K4] loading renders Skeleton with role=status + aria-busy + sr-only «Загрузка»', () => {
		render(<KpiCard slug="arrivals" title="Заезды сегодня" state={{ kind: 'loading' }} />)
		const card = screen.getByTestId('kpi-card-arrivals')
		expect(card.getAttribute('data-state')).toBe('loading')
		const status = within(card).getByRole('status')
		expect(status.getAttribute('aria-busy')).toBe('true')
		expect(within(status).getByText('Загрузка').className).toContain('sr-only')
		// Label visible — exact text match, not a soft existence check.
		expect(within(card).queryByText('Заезды сегодня')?.tagName).toBe('DIV')
	})
})

describe('KpiCard — Error state', () => {
	test('[K2, K5] error renders role=alert with assertive aria-live + exact message', () => {
		render(
			<KpiCard
				slug="arrivals"
				title="Заезды сегодня"
				state={{ kind: 'error', message: 'Не удалось загрузить' }}
			/>,
		)
		const card = screen.getByTestId('kpi-card-arrivals')
		expect(card.getAttribute('data-state')).toBe('error')
		const alert = within(card).getByRole('alert')
		expect(alert.getAttribute('aria-live')).toBe('assertive')
		expect(alert.textContent).toBe('Не удалось загрузить')
		// Number-shaped node MUST be absent (mutation gate against render leak).
		expect(within(card).queryByRole('status')).toBeNull()
	})
})

describe('KpiCard — Value state (canonical happy path)', () => {
	test('[K3, K6] value renders large number with tabular-nums class, no skeleton/alert', () => {
		render(<KpiCard slug="in-house" title="В отеле" state={{ kind: 'value', value: '12' }} />)
		const card = screen.getByTestId('kpi-card-in-house')
		expect(card.getAttribute('data-state')).toBe('value')
		const numberNode = within(card).getByText('12')
		expect(numberNode.className).toContain('tabular-nums')
		expect(within(card).queryByRole('status')).toBeNull()
		expect(within(card).queryByRole('alert')).toBeNull()
	})

	test('[K7] value + ariaValue → both render, ariaValue в .sr-only sibling', () => {
		render(
			<KpiCard
				slug="balance"
				title="Открытый баланс"
				state={{
					kind: 'value',
					value: '1 500,00 ₽',
					ariaValue: '1500 рублей 0 копеек',
				}}
			/>,
		)
		const card = screen.getByTestId('kpi-card-balance')
		expect(within(card).getByText('1 500,00 ₽').className).toContain('tabular-nums')
		const sr = within(card).getByText('1500 рублей 0 копеек')
		expect(sr.className).toContain('sr-only')
	})

	test('[K8] value without ariaValue → exactly one number node (no sr-only sibling)', () => {
		const { container } = render(
			<KpiCard slug="alerts" title="Неотправленные" state={{ kind: 'value', value: '3' }} />,
		)
		const srOnlyNodes = container.querySelectorAll('.sr-only')
		expect(srOnlyNodes.length).toBe(0)
	})

	test('[K10] value="0" rendered with text-muted-foreground (zero-state hint)', () => {
		render(<KpiCard slug="x" title="X" state={{ kind: 'value', value: '0' }} />)
		const numberNode = screen.getByText('0')
		expect(numberNode.className).toContain('text-muted-foreground')
	})

	test('[K11] value="0 ₽" rendered with text-muted-foreground (RU money zero)', () => {
		render(<KpiCard slug="x" title="X" state={{ kind: 'value', value: '0 ₽' }} />)
		const numberNode = screen.getByText('0 ₽')
		expect(numberNode.className).toContain('text-muted-foreground')
	})

	test('[K12] non-zero value NOT muted (real data full opacity)', () => {
		render(<KpiCard slug="x" title="X" state={{ kind: 'value', value: '5' }} />)
		const numberNode = screen.getByText('5')
		expect(numberNode.className).not.toContain('text-muted-foreground')
	})
})

describe('KpiCard — Title rendering + footnote optional', () => {
	test('[K9, K15] Cyrillic title rendered exactly, data-testid follows id', () => {
		render(<KpiCard slug="arrivals" title="В отеле сейчас" state={{ kind: 'value', value: '5' }} />)
		expect(screen.getByTestId('kpi-card-arrivals').getAttribute('data-state')).toBe('value')
		expect(screen.getByText('В отеле сейчас').tagName).toBe('DIV')
	})

	test('[K13] footnote prop renders below value', () => {
		render(
			<KpiCard slug="x" title="X" state={{ kind: 'value', value: '5' }} footnote="за сегодня" />,
		)
		expect(screen.getByText('за сегодня').tagName).toBe('P')
	})

	test('[K14] footnote omitted → no stray secondary line', () => {
		const { container } = render(
			<KpiCard slug="x" title="X" state={{ kind: 'value', value: '5' }} />,
		)
		// Exactly one <p> for the value (no second <p> for footnote).
		expect(container.querySelectorAll('p').length).toBe(1)
	})
})
