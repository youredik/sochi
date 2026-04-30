/**
 * Strict tests для PaymentMethodSelector — DOM-direct asserts (no jest-dom).
 *
 *   [PMS1] Renders 'card' + 'sbp' options
 *   [PMS2] value="card" → card option's data-state=checked
 *   [PMS3] value="sbp" → sbp option's data-state=checked
 *   [PMS4] Click sbp → onChange('sbp') called
 *   [PMS5] disabled=true → fieldset.disabled=true
 *   [PMS6] aria-label set on radio group
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { PaymentMethodSelector } from './payment-method-selector.tsx'

afterEach(() => {
	document.body.innerHTML = ''
})

/** Radix radio item — `data-state` attr === 'checked' | 'unchecked'. */
function isRadioChecked(el: Element): boolean {
	return el.getAttribute('data-state') === 'checked'
}

describe('PaymentMethodSelector', () => {
	test('[PMS1] renders card + sbp options', () => {
		render(<PaymentMethodSelector value="card" onChange={() => {}} />)
		// getByTestId throws if missing — implicit existence assert
		const card = screen.getByTestId('pm-card')
		const sbp = screen.getByTestId('pm-sbp')
		expect(card).toBeTruthy()
		expect(sbp).toBeTruthy()
	})

	test('[PMS2] value="card" → card radio checked', () => {
		render(<PaymentMethodSelector value="card" onChange={() => {}} />)
		const cardRadio = screen.getByRole('radio', { name: /банковская карта/i })
		expect(isRadioChecked(cardRadio)).toBe(true)
	})

	test('[PMS3] value="sbp" → sbp radio checked', () => {
		render(<PaymentMethodSelector value="sbp" onChange={() => {}} />)
		const sbpRadio = screen.getByRole('radio', { name: /СБП/i })
		expect(isRadioChecked(sbpRadio)).toBe(true)
	})

	test('[PMS4] click sbp → onChange("sbp") called', async () => {
		const onChange = vi.fn()
		render(<PaymentMethodSelector value="card" onChange={onChange} />)
		await userEvent.click(screen.getByRole('radio', { name: /СБП/i }))
		expect(onChange).toHaveBeenCalledWith('sbp')
	})

	test('[PMS5] disabled=true → fieldset.disabled=true', () => {
		render(<PaymentMethodSelector value="card" onChange={() => {}} disabled />)
		const fieldset = screen.getByTestId('payment-method-selector') as HTMLFieldSetElement
		expect(fieldset.disabled).toBe(true)
	})

	test('[PMS6] aria-label set on radio group', () => {
		render(<PaymentMethodSelector value="card" onChange={() => {}} />)
		expect(screen.getByRole('radiogroup').getAttribute('aria-label')).toBe('Способ оплаты')
	})
})
