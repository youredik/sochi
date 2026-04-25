/**
 * `<Money>` component — strict unit tests (DOM rendering).
 *
 * **Pre-done audit checklist (FROM START — feedback_pre_done_audit.md):**
 *
 *   Render correctness:
 *     [R1] Renders visible span with formatMoney output (RU locale)
 *     [R2] Renders sr-only span with formatMoneyA11y output (full pronunciation)
 *     [R3] Visible span has aria-hidden="true" (SR ignores)
 *     [R4] Sr-only span has class "sr-only" (visually hidden but SR reads)
 *     [R5] Custom className passed through to outer wrapper
 *     [R6] Default has `tabular-nums` class (column alignment)
 *
 *   Edge values:
 *     [E1] zero kopecks
 *     [E2] negative kopecks
 *     [E3] kopeck-precision boundary (1n, 99n, 100n)
 *
 *   Russian plural agreement (verified through formatMoneyA11y indirect):
 *     [P1] one form (1 рубль)
 *     [P2] few form (2-4 рубля)
 *     [P3] many form (5+ рублей)
 *     [P4] 11-19 always many (RU exception)
 *
 * Note: `<MoneyInput>` is a thin wrapper around `react-number-format`'s
 * NumericFormat — its behaviour is covered by the upstream library's tests.
 * We test only OUR config defaults are passed through (decimalSeparator,
 * thousandSeparator, inputMode, suffix) via integration on the form screens
 * later (M6.7.3+).
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { Money } from './money.tsx'

afterEach(cleanup)

describe('<Money> — rendering correctness', () => {
	test('[R1, R3] visible span = formatMoney output, aria-hidden=true', () => {
		const { container } = render(<Money kopecks={150_000n} />)
		// Querying by aria-hidden span text content
		const visible = container.querySelector('[aria-hidden="true"]')
		expect(visible).not.toBeNull()
		expect(visible?.textContent).toMatch(/1.500,00.₽/) // NBSP-tolerant regex
	})

	test('[R2, R4] sr-only span = formatMoneyA11y output (RU plural)', () => {
		const { container } = render(<Money kopecks={150_000n} />)
		const srOnly = container.querySelector('.sr-only')
		expect(srOnly).not.toBeNull()
		expect(srOnly?.textContent).toBe('1500 рублей 0 копеек')
	})

	test('[R5] custom className passes through to outer wrapper', () => {
		const { container } = render(<Money kopecks={100n} className="custom-test-class" />)
		const root = container.firstElementChild
		expect(root?.className).toContain('custom-test-class')
		expect(root?.className).toContain('tabular-nums') // R6 — base class preserved
	})

	test('[R6] default class includes "tabular-nums"', () => {
		const { container } = render(<Money kopecks={100n} />)
		const root = container.firstElementChild
		expect(root?.className).toContain('tabular-nums')
	})
})

describe('<Money> — edge values', () => {
	test('[E1] zero kopecks → "0,00 ₽" + "0 рублей 0 копеек"', () => {
		const { container } = render(<Money kopecks={0n} />)
		expect(container.querySelector('[aria-hidden]')?.textContent).toMatch(/0,00.₽/)
		expect(container.querySelector('.sr-only')?.textContent).toBe('0 рублей 0 копеек')
	})

	test('[E2] negative kopecks → minus sign in visible, signed integer in sr-only', () => {
		const { container } = render(<Money kopecks={-15_000n} />)
		const visible = container.querySelector('[aria-hidden]')?.textContent ?? ''
		expect(visible).toMatch(/^-/)
		expect(visible).toMatch(/150,00/)
		expect(visible).not.toContain('(') // never parentheses (anti-pattern)
		const sr = container.querySelector('.sr-only')?.textContent ?? ''
		expect(sr).toMatch(/-150 (рубль|рубля|рублей)/)
	})

	test('[E3] kopeck-precision boundary 1n', () => {
		const { container } = render(<Money kopecks={1n} />)
		expect(container.querySelector('[aria-hidden]')?.textContent).toMatch(/0,01.₽/)
		expect(container.querySelector('.sr-only')?.textContent).toBe('0 рублей 1 копейка')
	})

	test('[E3] kopeck-precision boundary 99n + 100n', () => {
		const { container: c99 } = render(<Money kopecks={99n} />)
		expect(c99.querySelector('.sr-only')?.textContent).toBe('0 рублей 99 копеек')

		cleanup()
		const { container: c100 } = render(<Money kopecks={100n} />)
		expect(c100.querySelector('.sr-only')?.textContent).toBe('1 рубль 0 копеек')
	})
})

describe('<Money> — RU plural agreement (visible via sr-only)', () => {
	test('[P1] one form: 1 рубль', () => {
		const { container } = render(<Money kopecks={100n} />)
		expect(container.querySelector('.sr-only')?.textContent).toContain('1 рубль')
	})

	test('[P2] few form: 2 рубля', () => {
		const { container } = render(<Money kopecks={200n} />)
		expect(container.querySelector('.sr-only')?.textContent).toContain('2 рубля')
	})

	test('[P3] many form: 5 рублей', () => {
		const { container } = render(<Money kopecks={500n} />)
		expect(container.querySelector('.sr-only')?.textContent).toContain('5 рублей')
	})

	test('[P4] 11-19 → always many (RU exception)', () => {
		cleanup()
		const { container: c11 } = render(<Money kopecks={1100n} />)
		expect(c11.querySelector('.sr-only')?.textContent).toContain('11 рублей')

		cleanup()
		const { container: c19 } = render(<Money kopecks={1900n} />)
		expect(c19.querySelector('.sr-only')?.textContent).toContain('19 рублей')

		// 21 and 31 are 'one' (ones-digit determines)
		cleanup()
		const { container: c21 } = render(<Money kopecks={2100n} />)
		expect(c21.querySelector('.sr-only')?.textContent).toContain('21 рубль')
	})
})
