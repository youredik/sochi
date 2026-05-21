/**
 * `<LandingPage>` — strict tests per `feedback_strict_tests.md`.
 *
 * Test matrix:
 *   ─── Brand + heading + sub + CTA prompt ────────────────────────
 *     [B1] brand «Сэпшн» rendered
 *     [H1] h1 exact text «Программа для управления гостевым домом
 *          или мини-отелем.»
 *     [S1] sub «Сделано в Сочи.» rendered
 *     [A1] CTA prompt «Свяжитесь любым удобным способом:» rendered
 *
 *   ─── Contact channels — key product surface ────────────────────
 *     [C1] Telegram link — href === https://t.me/sepshn (env fallback)
 *          + target="_blank" + rel="noopener noreferrer"
 *     [C2] Email link — href === mailto:hi@sepshn.ru (env fallback)
 *
 *   ─── Analytics — CTA goals (mailto: не покрывается trackLinks) ──
 *     [CTA1] Telegram click → reachGoal('tg_click')
 *     [CTA2] Email click → reachGoal('email_click')
 *     [CTA3] single click → single reachGoal call (no double-fire)
 *
 *   ─── Footer — 152-ФЗ minimal compliance ────────────────────────
 *     [F1] footer contains «© 2026 Сэпшн»
 *     [F2] footer contains canonical email format @sepshn.ru
 *
 *   ─── Anti-regression: no premature features ───────────────────
 *     [N1] NO «Попробовать демо» CTA (discovery-first canon — demo
 *          в звонке, не на лендинге)
 *     [N2] NO «1%» / pricing text (валидируется через пилоты, не лендинг)
 *     [N3] NO Bnovo/TravelLine comparison (38-ФЗ юр.риск)
 *     [N4] exactly one h1 (heading hierarchy)
 *
 * mock.module pattern: bun:test requires mock REGISTRATION перед import
 * mock'нутого модуля (`feedback_bun_test_canons_2026_05_13` §6). Здесь
 * `reachGoal` mocked — мы тестируем что click-handler вызывает функцию,
 * а не интеграцию с Y.Metrika (это покрыто yandex-metrika.test.ts).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const reachGoalMock = mock()
mock.module('../../lib/yandex-metrika.ts', () => ({
	reachGoal: reachGoalMock,
}))

import { LandingPage } from './landing-page.tsx'

beforeEach(() => {
	reachGoalMock.mockClear()
})

afterEach(() => {
	cleanup()
})

describe('<LandingPage>', () => {
	test('[B1] renders brand «Сэпшн»', () => {
		render(<LandingPage />)
		const matches = screen.getAllByText(/Сэпшн/)
		expect(matches.length).toBeGreaterThanOrEqual(1)
	})

	test('[H1] h1 exact text', () => {
		render(<LandingPage />)
		expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
			'Программа для управления гостевым домом или мини-отелем.',
		)
	})

	test('[S1] sub «Сделано в Сочи.»', () => {
		render(<LandingPage />)
		expect(screen.getByText('Сделано в Сочи.').textContent).toBe('Сделано в Сочи.')
	})

	test('[A1] CTA prompt above buttons', () => {
		render(<LandingPage />)
		expect(screen.getByText('Свяжитесь любым удобным способом:').textContent).toBe(
			'Свяжитесь любым удобным способом:',
		)
	})

	test('[C1] Telegram link — external + safe rel', () => {
		render(<LandingPage />)
		const tg = screen.getByRole('link', { name: 'Telegram' })
		expect(tg.getAttribute('href')).toBe('https://t.me/sepshn')
		expect(tg.getAttribute('target')).toBe('_blank')
		expect(tg.getAttribute('rel')).toBe('noopener noreferrer')
	})

	test('[C2] Email link — mailto к sepshn.ru', () => {
		render(<LandingPage />)
		const email = screen.getByRole('link', { name: 'Email' })
		expect(email.getAttribute('href')).toBe('mailto:hi@sepshn.ru')
	})

	test('[CTA1] Telegram click → reachGoal("tg_click")', () => {
		render(<LandingPage />)
		fireEvent.click(screen.getByRole('link', { name: 'Telegram' }))
		expect(reachGoalMock.mock.calls.length).toBe(1)
		expect(reachGoalMock.mock.calls[0]).toEqual(['tg_click'])
	})

	test('[CTA2] Email click → reachGoal("email_click")', () => {
		render(<LandingPage />)
		fireEvent.click(screen.getByRole('link', { name: 'Email' }))
		expect(reachGoalMock.mock.calls.length).toBe(1)
		expect(reachGoalMock.mock.calls[0]).toEqual(['email_click'])
	})

	test('[CTA3] single click → single reachGoal call (no double-fire)', () => {
		render(<LandingPage />)
		fireEvent.click(screen.getByRole('link', { name: 'Telegram' }))
		// одна click → один reachGoal — anti-pattern «двойного fire'а»
		// from re-render / event bubbling.
		expect(reachGoalMock.mock.calls.length).toBe(1)
	})

	test('[F1] footer copyright «© 2026 Сэпшн»', () => {
		render(<LandingPage />)
		const footer = screen.getByText(/© 2026 Сэпшн/)
		expect(footer.textContent).toContain('© 2026 Сэпшн')
	})

	test('[F2] footer contains @sepshn.ru email', () => {
		render(<LandingPage />)
		const footer = screen.getByText(/© 2026 Сэпшн/)
		expect(footer.textContent).toMatch(/@sepshn\.ru/)
	})

	test('[N1] NO «Попробовать демо» CTA (discovery-first canon)', () => {
		render(<LandingPage />)
		expect(screen.queryByText(/Попробовать демо/i)).toBeNull()
		expect(screen.queryByText(/попробовать/i)).toBeNull()
	})

	test('[N2] NO pricing «1%» text on landing (валидируется через пилоты)', () => {
		render(<LandingPage />)
		expect(screen.queryByText(/1%/)).toBeNull()
		expect(screen.queryByText(/комиссия/i)).toBeNull()
		expect(screen.queryByText(/бесплатно/i)).toBeNull()
	})

	test('[N3] NO comparison block с конкурентами (38-ФЗ юр.риск)', () => {
		render(<LandingPage />)
		expect(screen.queryByText(/Bnovo/i)).toBeNull()
		expect(screen.queryByText(/TravelLine/i)).toBeNull()
		expect(screen.queryByText(/сравнение/i)).toBeNull()
	})

	test('[N4] exactly one h1 (heading hierarchy)', () => {
		render(<LandingPage />)
		expect(screen.getAllByRole('heading', { level: 1 }).length).toBe(1)
	})
})
