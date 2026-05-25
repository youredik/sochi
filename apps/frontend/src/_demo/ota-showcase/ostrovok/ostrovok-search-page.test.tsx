/**
 * <OstrovokSearchPage> — strict tests.
 *
 * Coverage mirrors <YandexSearchPage> с adjusted brand assertions:
 *   [R1] DemoDisclaimerBanner present (testid)
 *   [R2] h1 exact text «Куда вы хотите поехать?»
 *   [R3] all 4 inputs render (заезд / выезд / взрослые / дети)
 *   [R4] inputs have non-empty default values (today+7, today+9, 2, 0)
 *   [R5] «Островок.ru» wordmark rendered
 *   [R6] submit invokes onSearch с current form values + SANDBOX_DEMO_HID
 *   [R7] footer disclaimer с «Emerging Travel Group» legal note present
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SANDBOX_DEMO_HID } from './api-client.ts'
import { OstrovokSearchPage } from './ostrovok-search-page.tsx'

afterEach(() => {
	cleanup()
})

describe('<OstrovokSearchPage>', () => {
	test('[R1] DemoDisclaimerBanner present', () => {
		render(<OstrovokSearchPage onSearch={() => {}} />)
		expect(screen.getByTestId('demo-disclaimer-banner').textContent).toContain(
			'Демонстрация Sepshn',
		)
	})

	test('[R2] h1 exact text', () => {
		render(<OstrovokSearchPage onSearch={() => {}} />)
		expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Куда вы хотите поехать?')
	})

	test('[R3] all 4 form inputs render', () => {
		render(<OstrovokSearchPage onSearch={() => {}} />)
		expect(screen.getByLabelText('Заезд').getAttribute('type')).toBe('date')
		expect(screen.getByLabelText('Выезд').getAttribute('type')).toBe('date')
		expect(screen.getByLabelText('Взрослые').getAttribute('type')).toBe('number')
		expect(screen.getByLabelText('Дети').getAttribute('type')).toBe('number')
	})

	test('[R4] inputs have non-empty default values', () => {
		render(<OstrovokSearchPage onSearch={() => {}} />)
		const checkin = screen.getByLabelText('Заезд') as HTMLInputElement
		const checkout = screen.getByLabelText('Выезд') as HTMLInputElement
		const adults = screen.getByLabelText('Взрослые') as HTMLInputElement
		const children = screen.getByLabelText('Дети') as HTMLInputElement
		expect(checkin.value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		expect(checkout.value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		expect(adults.value).toBe('2')
		expect(children.value).toBe('0')
	})

	test('[R5] Островок.ru wordmark rendered', () => {
		render(<OstrovokSearchPage onSearch={() => {}} />)
		expect(screen.getByTestId('ostrovok-wordmark').textContent).toBe('Островок.ru')
	})

	test('[R6] submit invokes onSearch с form values + SANDBOX_DEMO_HID', () => {
		let captured: Parameters<Parameters<typeof OstrovokSearchPage>[0]['onSearch']>[0] | null = null
		render(<OstrovokSearchPage onSearch={(p) => (captured = p)} />)
		const checkin = screen.getByLabelText('Заезд') as HTMLInputElement
		const checkout = screen.getByLabelText('Выезд') as HTMLInputElement
		const adults = screen.getByLabelText('Взрослые') as HTMLInputElement

		fireEvent.change(checkin, { target: { value: '2026-08-01' } })
		fireEvent.change(checkout, { target: { value: '2026-08-05' } })
		fireEvent.change(adults, { target: { value: '3' } })

		const submitBtn = screen.getByTestId('ostrovok-search-submit')
		fireEvent.click(submitBtn)

		expect(captured).not.toBeNull()
		expect(captured!.hid).toBe(SANDBOX_DEMO_HID)
		expect(captured!.checkinDate).toBe('2026-08-01')
		expect(captured!.checkoutDate).toBe('2026-08-05')
		expect(captured!.adults).toBe(3)
		expect(captured!.children).toBe(0)
	})

	test('[R7] footer disclaimer с Emerging Travel Group legal note', () => {
		render(<OstrovokSearchPage onSearch={() => {}} />)
		const footer = screen.getByTestId('demo-disclaimer-footer')
		expect(footer.textContent).toContain('Emerging Travel Group')
	})
})
