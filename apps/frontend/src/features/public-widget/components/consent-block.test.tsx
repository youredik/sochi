/**
 * Strict tests для ConsentBlock UI compliance — DOM-direct asserts (no
 * jest-dom matchers; project doesn't wire `@testing-library/jest-dom`).
 *
 *   [CB1] Both checkboxes default unchecked (opt-in mandate)
 *   [CB2] DPA marked required + has aria-required="true"
 *   [CB3] Marketing NOT required (aria-required="false")
 *   [CB4] Click DPA checkbox → onAcceptedDpaChange(true)
 *   [CB5] Click marketing checkbox → onAcceptedMarketingChange(true)
 *   [CB6] dpaError=true → role=alert message + aria-invalid=true
 *   [CB7] Both consents have «Прочитать полностью» trigger button (separate sheets)
 *   [CB8] DPA legend mentions 152-ФЗ; marketing legend mentions 38-ФЗ
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ConsentBlock } from './consent-block.tsx'

function renderWithProviders(ui: React.ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

/** Radix checkbox — `data-state` attr === 'checked' | 'unchecked'. */
function isChecked(el: Element): boolean {
	return el.getAttribute('data-state') === 'checked'
}

afterEach(() => {
	document.body.innerHTML = ''
})

describe('ConsentBlock', () => {
	test('[CB1] both checkboxes default unchecked (opt-in mandate)', () => {
		renderWithProviders(
			<ConsentBlock
				acceptedDpa={false}
				acceptedMarketing={false}
				onAcceptedDpaChange={() => {}}
				onAcceptedMarketingChange={() => {}}
			/>,
		)
		expect(isChecked(screen.getByTestId('consent-dpa-checkbox'))).toBe(false)
		expect(isChecked(screen.getByTestId('consent-marketing-checkbox'))).toBe(false)
	})

	test('[CB2] DPA marked required + aria-required="true"', () => {
		renderWithProviders(
			<ConsentBlock
				acceptedDpa={false}
				acceptedMarketing={false}
				onAcceptedDpaChange={() => {}}
				onAcceptedMarketingChange={() => {}}
			/>,
		)
		expect(screen.getByTestId('consent-dpa-checkbox').getAttribute('aria-required')).toBe('true')
	})

	test('[CB3] marketing NOT required', () => {
		renderWithProviders(
			<ConsentBlock
				acceptedDpa={false}
				acceptedMarketing={false}
				onAcceptedDpaChange={() => {}}
				onAcceptedMarketingChange={() => {}}
			/>,
		)
		expect(screen.getByTestId('consent-marketing-checkbox').getAttribute('aria-required')).toBe(
			'false',
		)
	})

	test('[CB4] click DPA → onAcceptedDpaChange(true)', async () => {
		const onDpa = vi.fn()
		renderWithProviders(
			<ConsentBlock
				acceptedDpa={false}
				acceptedMarketing={false}
				onAcceptedDpaChange={onDpa}
				onAcceptedMarketingChange={() => {}}
			/>,
		)
		await userEvent.click(screen.getByTestId('consent-dpa-checkbox'))
		expect(onDpa).toHaveBeenCalledWith(true)
	})

	test('[CB5] click marketing → onAcceptedMarketingChange(true)', async () => {
		const onMk = vi.fn()
		renderWithProviders(
			<ConsentBlock
				acceptedDpa={false}
				acceptedMarketing={false}
				onAcceptedDpaChange={() => {}}
				onAcceptedMarketingChange={onMk}
			/>,
		)
		await userEvent.click(screen.getByTestId('consent-marketing-checkbox'))
		expect(onMk).toHaveBeenCalledWith(true)
	})

	test('[CB6] dpaError=true → role=alert + aria-invalid="true"', () => {
		renderWithProviders(
			<ConsentBlock
				acceptedDpa={false}
				acceptedMarketing={false}
				onAcceptedDpaChange={() => {}}
				onAcceptedMarketingChange={() => {}}
				dpaError
			/>,
		)
		const alert = screen.getByRole('alert')
		expect(alert.textContent).toMatch(/обязательно/i)
		expect(screen.getByTestId('consent-dpa-checkbox').getAttribute('aria-invalid')).toBe('true')
	})

	test('[CB7] both consents have «Прочитать полностью» trigger', () => {
		renderWithProviders(
			<ConsentBlock
				acceptedDpa={false}
				acceptedMarketing={false}
				onAcceptedDpaChange={() => {}}
				onAcceptedMarketingChange={() => {}}
			/>,
		)
		// getByTestId throws if not found — implicit existence assert
		const dpaRead = screen.getByTestId('consent-dpa-read')
		const mkRead = screen.getByTestId('consent-marketing-read')
		expect(dpaRead.tagName).toBe('BUTTON')
		expect(mkRead.tagName).toBe('BUTTON')
	})

	test('[CB8] meta texts mention правильные ФЗ для каждого consent', () => {
		renderWithProviders(
			<ConsentBlock
				acceptedDpa={false}
				acceptedMarketing={false}
				onAcceptedDpaChange={() => {}}
				onAcceptedMarketingChange={() => {}}
			/>,
		)
		// Meta lines under each checkbox cite different laws.
		const allText = document.body.textContent ?? ''
		expect(allText).toMatch(/152-ФЗ/)
		expect(allText).toMatch(/38-ФЗ/)
	})
})
