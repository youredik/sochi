/**
 * MagicLinkSignUpForm — strict tests (passwordless canon 2026-05-13 per
 * `[[auth-passwordless-canon]]`).
 *
 * Pre-done audit:
 *   [R1] form renders email + orgName inputs + consent checkbox + captcha
 *        widget + «Получить ссылку для регистрации» submit
 *   [R2] CaptchaField rendered when captchaEnforced (mocked true)
 *   [R3] slug preview updates live as user types orgName
 *   [P1] submit disabled while orgName < 2 chars (form-level minLength)
 *   [P2] submit disabled while consent unchecked (152-ФЗ hard gate)
 *   [P3] submit disabled while captcha enforced + token empty
 *   [P4] happy path: signIn.magicLink called with email + callbackURL
 *        `/welcome?n=<encoded orgName>` + captchaToken merged into body
 *        per captchaFetchOptions canon
 *   [P5] success response → confirmation state с typed email + orgName
 *        rendered for re-confirmation
 *   [P6] BA error → localized banner + captcha cleared (next attempt
 *        requires fresh challenge per single-use Yandex SmartCaptcha token)
 *
 * Mocking strategy mirrors `magic-link-form.test.tsx`: force
 * `captchaEnforced=true` (decoupled from env-load timing per
 * `[[bun-test-canons-2026-05-13]]`) AND stub CaptchaField as a deterministic
 * test button. CaptchaField's env gating covered separately by
 * `captcha-field.test.tsx`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'

const magicLinkMock = mock()
mock.module('@/lib/auth-client', () => ({
	authClient: { signIn: { magicLink: magicLinkMock } },
	sessionQueryOptions: { queryKey: ['auth', 'session'] as const },
}))

mock.module('@/features/auth/lib/captcha', () => ({
	captchaEnforced: true,
}))

mock.module('@/features/auth/components/captcha-field', () => ({
	CaptchaField: (props: { onToken: (t: string) => void }) =>
		React.createElement(
			'button',
			{
				type: 'button',
				'data-testid': 'cap-success',
				onClick: () => props.onToken('tok-signup-magic-789'),
			},
			'solve',
		),
}))

mock.module('@tanstack/react-router', () => ({
	Link: (props: { children: React.ReactNode; to: string }) =>
		React.createElement('a', { href: props.to }, props.children),
	useNavigate: () => () => {},
}))

const { MagicLinkSignUpForm } = await import('./magic-link-signup-form')

function renderWithQuery(ui: React.ReactElement) {
	const queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	})
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

afterEach(() => {
	cleanup()
	mock.clearAllMocks()
})

describe('MagicLinkSignUpForm — initial render', () => {
	it('[R1] renders email + orgName inputs + consent checkbox + submit button', () => {
		renderWithQuery(<MagicLinkSignUpForm />)
		const email = screen.getByLabelText('Email') as HTMLInputElement
		expect(email.type).toBe('email')
		expect(email.required).toBe(true)
		const orgName = screen.getByLabelText('Название гостиницы') as HTMLInputElement
		expect(orgName.type).toBe('text')
		expect(orgName.required).toBe(true)
		expect(orgName.minLength).toBe(2)
		expect(orgName.maxLength).toBe(80)
		const submit = screen.getByRole('button', { name: 'Получить ссылку для регистрации' })
		expect((submit as HTMLButtonElement).disabled).toBe(true) // every gate empty
	})

	it('[R2] renders CaptchaField when captchaEnforced=true', () => {
		renderWithQuery(<MagicLinkSignUpForm />)
		const captchaButton = screen.getByTestId('cap-success')
		expect(captchaButton.tagName).toBe('BUTTON')
		expect((captchaButton as HTMLButtonElement).type).toBe('button')
	})

	it('[R3] slug preview updates live as user types orgName', async () => {
		renderWithQuery(<MagicLinkSignUpForm />)
		await userEvent.setup().type(screen.getByLabelText('Название гостиницы'), 'Гостиница Ромашка')
		const slugSpan = screen.getByText(/\/o\//)
		expect(slugSpan.textContent?.startsWith('/o/')).toBe(true)
		expect(slugSpan.textContent).not.toBe('/o/…')
	})
})

describe('MagicLinkSignUpForm — submit gating', () => {
	it('[P1] submit disabled while orgName too short (<2 chars)', async () => {
		renderWithQuery(<MagicLinkSignUpForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Email'), 'jane@example.com')
		await user.type(screen.getByLabelText('Название гостиницы'), 'X') // single char
		await user.click(screen.getByLabelText(/согласие/))
		await user.click(screen.getByTestId('cap-success'))
		const submit = screen.getByRole('button', { name: 'Получить ссылку для регистрации' })
		expect((submit as HTMLButtonElement).disabled).toBe(true)
	})

	it('[P2] submit disabled while consent unchecked (152-ФЗ hard gate)', async () => {
		renderWithQuery(<MagicLinkSignUpForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Email'), 'jane@example.com')
		await user.type(screen.getByLabelText('Название гостиницы'), 'Гостиница Ромашка')
		await user.click(screen.getByTestId('cap-success'))
		// Deliberately NOT checking consent.
		const submit = screen.getByRole('button', { name: 'Получить ссылку для регистрации' })
		expect((submit as HTMLButtonElement).disabled).toBe(true)
	})

	it('[P3] submit disabled while captcha enforced + token empty', async () => {
		renderWithQuery(<MagicLinkSignUpForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Email'), 'jane@example.com')
		await user.type(screen.getByLabelText('Название гостиницы'), 'Гостиница Ромашка')
		await user.click(screen.getByLabelText(/согласие/))
		const submit = screen.getByRole('button', { name: 'Получить ссылку для регистрации' })
		expect((submit as HTMLButtonElement).disabled).toBe(true)
	})
})

describe('MagicLinkSignUpForm — successful submit', () => {
	it('[P4] calls signIn.magicLink with email + callbackURL=/welcome?n=<encoded> + captchaToken in 2nd-arg body', async () => {
		magicLinkMock.mockResolvedValueOnce({ data: { status: true }, error: null })
		renderWithQuery(<MagicLinkSignUpForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Email'), 'jane@example.com')
		await user.type(screen.getByLabelText('Название гостиницы'), 'Гостиница Ромашка')
		await user.click(screen.getByLabelText(/согласие/))
		await user.click(screen.getByTestId('cap-success'))
		await user.click(screen.getByRole('button', { name: 'Получить ссылку для регистрации' }))

		await waitFor(() => {
			expect(magicLinkMock).toHaveBeenCalledTimes(1)
		})
		const expectedCallback = `http://localhost/welcome?n=${encodeURIComponent('Гостиница Ромашка')}`
		expect(magicLinkMock).toHaveBeenCalledWith(
			{ email: 'jane@example.com', callbackURL: expectedCallback },
			{ body: { captchaToken: 'tok-signup-magic-789' } },
		)
	})

	it('[P5] success → confirmation state с typed email AND orgName rendered for re-confirmation', async () => {
		magicLinkMock.mockResolvedValueOnce({ data: { status: true }, error: null })
		renderWithQuery(<MagicLinkSignUpForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Email'), 'jane@example.com')
		await user.type(screen.getByLabelText('Название гостиницы'), 'Гостиница Ромашка')
		await user.click(screen.getByLabelText(/согласие/))
		await user.click(screen.getByTestId('cap-success'))
		await user.click(screen.getByRole('button', { name: 'Получить ссылку для регистрации' }))

		await waitFor(() => {
			expect(screen.queryByText('Письмо отправлено')).not.toBe(null)
		})
		// Email and orgName both rendered inside <strong> tags in confirmation
		// copy so user sees BOTH for re-verification before clicking the
		// magic-link in their inbox.
		const emailEl = screen.getByText('jane@example.com')
		expect(emailEl.tagName).toBe('STRONG')
		const orgEl = screen.getByText('Гостиница Ромашка')
		expect(orgEl.tagName).toBe('STRONG')
	})
})

describe('MagicLinkSignUpForm — error path', () => {
	it('[P6] BA error → localized banner + captcha cleared (submit re-disabled)', async () => {
		magicLinkMock.mockResolvedValueOnce({
			data: null,
			error: { status: 429, code: 'TOO_MANY_REQUESTS' },
		})
		renderWithQuery(<MagicLinkSignUpForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Email'), 'jane@example.com')
		await user.type(screen.getByLabelText('Название гостиницы'), 'Гостиница Ромашка')
		await user.click(screen.getByLabelText(/согласие/))
		await user.click(screen.getByTestId('cap-success'))
		await user.click(screen.getByRole('button', { name: 'Получить ссылку для регистрации' }))

		await waitFor(() => {
			expect(screen.queryByRole('alert')).not.toBe(null)
		})
		const errorTitle = screen.getByText('Слишком много попыток')
		expect(errorTitle.tagName).toBe('P')
		// Captcha token reset → submit blocked (also blocking=true via 429 mapping).
		const submit = screen.getByRole('button', { name: 'Получить ссылку для регистрации' })
		expect((submit as HTMLButtonElement).disabled).toBe(true)
	})
})
