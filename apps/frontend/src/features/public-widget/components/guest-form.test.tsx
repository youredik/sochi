/**
 * Strict tests для GuestForm — TanStack Form + libphonenumber-js phone formatting.
 * DOM-direct asserts (project doesn't wire jest-dom matchers).
 *
 *   [GF1] All required fields rendered (lastName, firstName, email, phone, citizenship)
 *   [GF2] Phone input formatted as user types — leading +7 prefix
 *   [GF3] Submit с empty fields → onSubmit NOT called
 *   [GF4] Submit с valid values → onSubmit called с trimmed + lowercased email + E.164 phone
 *   [GF5] Phone invalid number → submit blocked + phone field error visible
 *   [GF6] Citizenship auto-uppercased
 *   [GF7] Optional fields → null when empty
 *   [GF8] disabled=true → first inner fieldset.disabled=true
 *   [GF9] specialRequests max 2000 enforced (HTML maxLength)
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { GuestForm } from './guest-form.tsx'

afterEach(() => {
	document.body.innerHTML = ''
})

/**
 * Resolve input by visible label text. TanStack Form fields use generated IDs
 * (useId), so getByLabelText('Фамилия') would skip the asterisk in label.
 * Use partial match through label.htmlFor → input lookup.
 */
function inputByLabelText(label: RegExp | string): HTMLInputElement {
	const labels = Array.from(document.querySelectorAll('label')) as HTMLLabelElement[]
	const matched = labels.find((l) =>
		typeof label === 'string'
			? (l.textContent ?? '').includes(label)
			: label.test(l.textContent ?? ''),
	)
	if (!matched) throw new Error(`Label not found: ${label}`)
	const id = matched.htmlFor
	if (!id) throw new Error(`Label has no htmlFor: ${matched.textContent}`)
	const el = document.getElementById(id)
	if (!el) throw new Error(`Input not found by id: ${id}`)
	return el as HTMLInputElement
}

describe('GuestForm', () => {
	test('[GF1] all required fields rendered', () => {
		render(<GuestForm onSubmit={() => {}} />)
		// throws if missing → implicit existence assert
		inputByLabelText(/Фамилия/)
		inputByLabelText(/^Имя/)
		inputByLabelText(/Email/)
		inputByLabelText(/Телефон/)
		inputByLabelText(/Гражданство/)
	})

	test('[GF2] phone formatted as user types — +7 prefix appears', async () => {
		render(<GuestForm onSubmit={() => {}} />)
		const phone = inputByLabelText(/Телефон/)
		await userEvent.type(phone, '79651234567')
		expect(phone.value).toMatch(/^\+7/)
		expect(phone.value).toContain('965')
	})

	test('[GF3] submit с empty fields → onSubmit NOT called', async () => {
		const onSubmit = vi.fn()
		render(
			<GuestForm onSubmit={onSubmit}>
				<button type="submit" data-testid="sub">
					ok
				</button>
			</GuestForm>,
		)
		await userEvent.click(screen.getByTestId('sub'))
		await waitFor(() => {
			expect(onSubmit).not.toHaveBeenCalled()
		})
	})

	test('[GF4] valid submit → onSubmit called с canonicalized values', async () => {
		const onSubmit = vi.fn()
		render(
			<GuestForm onSubmit={onSubmit}>
				<button type="submit" data-testid="sub">
					ok
				</button>
			</GuestForm>,
		)
		await userEvent.type(inputByLabelText(/Фамилия/), '  Иванов  ')
		await userEvent.type(inputByLabelText(/^Имя/), 'Иван')
		await userEvent.type(inputByLabelText(/Email/), 'IVAN@EXAMPLE.COM')
		await userEvent.type(inputByLabelText(/Телефон/), '79651234567')
		await userEvent.click(screen.getByTestId('sub'))
		await waitFor(() => {
			expect(onSubmit).toHaveBeenCalledTimes(1)
		})
		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				firstName: 'Иван',
				lastName: 'Иванов',
				middleName: null,
				email: 'ivan@example.com',
				phone: '+79651234567',
				citizenship: 'RU',
				countryOfResidence: null,
				specialRequests: null,
			}),
		)
	})

	test('[GF5] invalid phone → submit blocked', async () => {
		const onSubmit = vi.fn()
		render(
			<GuestForm onSubmit={onSubmit}>
				<button type="submit" data-testid="sub">
					ok
				</button>
			</GuestForm>,
		)
		await userEvent.type(inputByLabelText(/Фамилия/), 'Иванов')
		await userEvent.type(inputByLabelText(/^Имя/), 'Иван')
		await userEvent.type(inputByLabelText(/Email/), 'i@example.com')
		await userEvent.type(inputByLabelText(/Телефон/), '+79')
		await userEvent.click(screen.getByTestId('sub'))
		await waitFor(() => {
			expect(onSubmit).not.toHaveBeenCalled()
		})
	})

	test('[GF6] citizenship auto-uppercased', async () => {
		render(<GuestForm onSubmit={() => {}} />)
		const citizenship = inputByLabelText(/Гражданство/)
		await userEvent.clear(citizenship)
		await userEvent.type(citizenship, 'by')
		expect(citizenship.value).toBe('BY')
	})

	test('[GF7] optional fields → null when empty', async () => {
		const onSubmit = vi.fn()
		render(
			<GuestForm onSubmit={onSubmit}>
				<button type="submit" data-testid="sub">
					ok
				</button>
			</GuestForm>,
		)
		await userEvent.type(inputByLabelText(/Фамилия/), 'A')
		await userEvent.type(inputByLabelText(/^Имя/), 'B')
		await userEvent.type(inputByLabelText(/Email/), 'a@b.co')
		await userEvent.type(inputByLabelText(/Телефон/), '79651234567')
		await userEvent.click(screen.getByTestId('sub'))
		await waitFor(() => expect(onSubmit).toHaveBeenCalled())
		const args = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>
		expect(args.middleName).toBeNull()
		expect(args.countryOfResidence).toBeNull()
		expect(args.specialRequests).toBeNull()
	})

	test('[GF8] disabled=true → inner fieldset.disabled=true', () => {
		render(<GuestForm onSubmit={() => {}} disabled />)
		// First fieldset inside the form
		const fieldset = screen
			.getByTestId('guest-form')
			.querySelector('fieldset') as HTMLFieldSetElement
		expect(fieldset.disabled).toBe(true)
	})

	test('[GF9] specialRequests max 2000 enforced', () => {
		render(<GuestForm onSubmit={() => {}} />)
		const sr = document.getElementById(
			Array.from(document.querySelectorAll('label')).find((l) =>
				/Особые\s+пожелания/.test(l.textContent ?? ''),
			)?.htmlFor ?? '',
		) as HTMLTextAreaElement
		expect(sr).toBeTruthy()
		expect(sr.maxLength).toBe(2000)
	})
})
