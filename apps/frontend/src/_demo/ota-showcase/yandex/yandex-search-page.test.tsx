/**
 * <YandexSearchPage> — strict tests.
 *
 * Coverage:
 *   [R1] DemoDisclaimerBanner present (testid)
 *   [R2] h1 exact text «Куда вы хотите поехать?»
 *   [R3] all 4 inputs render (заезд / выезд / взрослые / дети)
 *   [R4] inputs have non-empty default values (today+7, today+9, 2, 0)
 *   [R5] «Yandex.Путешествия» wordmark rendered
 *   [R6] submit invokes onSearch with current form values
 *   [R7] footer disclaimer with «ООО „Яндекс.Путешествия"» legal note present
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_HOTEL_ID } from './api-client.ts'
import { YandexSearchPage } from './yandex-search-page.tsx'

afterEach(() => {
	cleanup()
})

describe('<YandexSearchPage>', () => {
	test('[R1] DemoDisclaimerBanner present', () => {
		render(<YandexSearchPage onSearch={() => {}} />)
		expect(screen.getByTestId('demo-disclaimer-banner').textContent).toContain(
			'Демонстрация Sepshn',
		)
	})

	test('[R2] h1 exact text', () => {
		render(<YandexSearchPage onSearch={() => {}} />)
		expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Куда вы хотите поехать?')
	})

	test('[R3] all 4 form inputs render', () => {
		render(<YandexSearchPage onSearch={() => {}} />)
		expect(screen.getByLabelText('Заезд').getAttribute('type')).toBe('date')
		expect(screen.getByLabelText('Выезд').getAttribute('type')).toBe('date')
		expect(screen.getByLabelText('Взрослые').getAttribute('type')).toBe('number')
		expect(screen.getByLabelText('Дети').getAttribute('type')).toBe('number')
	})

	test('[R4] inputs have non-empty default values', () => {
		render(<YandexSearchPage onSearch={() => {}} />)
		const checkin = screen.getByLabelText('Заезд') as HTMLInputElement
		const checkout = screen.getByLabelText('Выезд') as HTMLInputElement
		const adults = screen.getByLabelText('Взрослые') as HTMLInputElement
		const children = screen.getByLabelText('Дети') as HTMLInputElement
		expect(checkin.value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		expect(checkout.value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		expect(adults.value).toBe('2')
		expect(children.value).toBe('0')
	})

	test('[R5] Yandex.Путешествия wordmark rendered', () => {
		render(<YandexSearchPage onSearch={() => {}} />)
		expect(screen.getByTestId('yandex-wordmark').textContent).toBe('Yandex.Путешествия')
	})

	test('[R6] submit invokes onSearch with form values', () => {
		let captured: Parameters<Parameters<typeof YandexSearchPage>[0]['onSearch']>[0] | null = null
		render(<YandexSearchPage onSearch={(p) => (captured = p)} />)
		const checkin = screen.getByLabelText('Заезд') as HTMLInputElement
		const checkout = screen.getByLabelText('Выезд') as HTMLInputElement
		const adults = screen.getByLabelText('Взрослые') as HTMLInputElement

		fireEvent.change(checkin, { target: { value: '2026-08-01' } })
		fireEvent.change(checkout, { target: { value: '2026-08-05' } })
		fireEvent.change(adults, { target: { value: '3' } })

		const submitBtn = screen.getByTestId('yandex-search-submit')
		fireEvent.click(submitBtn)

		expect(captured).not.toBeNull()
		expect(captured!.hotelId).toBe(DEFAULT_HOTEL_ID)
		expect(captured!.checkinDate).toBe('2026-08-01')
		expect(captured!.checkoutDate).toBe('2026-08-05')
		expect(captured!.adults).toBe(3)
		expect(captured!.children).toBe(0)
	})

	test('[R7] footer disclaimer carries trademark-safe Yandex legal mention', () => {
		// Round 12 — legal phrasing updated. Previously the footer carried
		// «ООО „Яндекс.Путешествия" (ИНН: 7704735704)» which is factually
		// incorrect (ИНН 7704735704 belongs to ООО „ЯНДЕКС.ТАКСИ"). New
		// phrasing is jurisdiction-neutral and includes «ООО „Яндекс"» without
		// inventing a specific subsidiary entity that may not exist.
		render(<YandexSearchPage onSearch={() => {}} />)
		const footer = screen.getByTestId('demo-disclaimer-footer')
		expect(footer.textContent).toContain('ООО „Яндекс"')
		expect(footer.textContent).toContain('собственность соответствующих правообладателей')
	})
})
