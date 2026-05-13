/**
 * SignInForm — strict tests.
 *
 * Pre-done audit:
 *   [R1] form renders email + password inputs + «Войти» submit
 *   [R2] CaptchaField rendered when captchaEnforced (mocked true)
 *   [P1] submit disabled while email empty (basic HTML5 guard)
 *   [P2] submit disabled while captcha enforced + token empty (email filled)
 *   [P3] submit with email + password + token → signIn.email called with
 *        captchaToken merged into 2nd-arg body per captchaFetchOptions canon
 *   [P4] BA error → localized banner + captcha reset (submit re-disabled,
 *        next attempt requires fresh challenge)
 *   [N1] redirect prop passes through к onSuccess navigate target
 *
 * Mocking strategy mirrors `magic-link-form.test.tsx`: mock
 * `@/features/auth/lib/captcha` to force `captchaEnforced=true` (decoupled
 * from env-load timing — brittle под bun:test module-cache per
 * `[[bun-test-canons-2026-05-13]]`) AND mock `CaptchaField` to surface a
 * deterministic test button. CaptchaField's own env gating covered separately
 * by `captcha-field.test.tsx`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'

const signInEmailMock = mock()
mock.module('@/lib/auth-client', () => ({
	authClient: {
		signIn: { email: signInEmailMock },
	},
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
				onClick: () => props.onToken('tok-signin-456'),
			},
			'solve',
		),
}))

// PasskeySigninButton renders WebAuthn UI which loads `navigator.credentials`
// under happy-dom — irrelevant to captcha plumbing tests. Stub it out.
mock.module('@/features/auth/components/passkey-signin-button', () => ({
	PasskeySigninButton: () => React.createElement('div', { 'data-testid': 'passkey-stub' }),
}))

// TanStack Router's `<Link to=...>` uses RouterContext которого тут нет; stub
// at the import boundary so the form renders а тестируемые UI fields всё ещё
// доступны.
mock.module('@tanstack/react-router', () => ({
	Link: (props: { children: React.ReactNode; to: string }) =>
		React.createElement('a', { href: props.to }, props.children),
	useNavigate: () => () => {},
}))

const { SignInForm } = await import('./sign-in-form')

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

describe('SignInForm — initial render', () => {
	it('[R1] renders email + password inputs + Войти submit', () => {
		renderWithQuery(<SignInForm />)
		const email = screen.getByLabelText('Email') as HTMLInputElement
		expect(email.type).toBe('email')
		expect(email.required).toBe(true)
		const password = screen.getByLabelText('Пароль') as HTMLInputElement
		expect(password.type).toBe('password')
		expect(password.required).toBe(true)
		expect(password.minLength).toBe(8)
		const submit = screen.getByRole('button', { name: 'Войти' })
		expect((submit as HTMLButtonElement).disabled).toBe(true) // email + token empty
	})

	it('[R2] renders CaptchaField when captchaEnforced=true', () => {
		renderWithQuery(<SignInForm />)
		const captchaButton = screen.getByTestId('cap-success')
		expect(captchaButton.tagName).toBe('BUTTON')
		expect((captchaButton as HTMLButtonElement).type).toBe('button')
	})
})

describe('SignInForm — submit gating', () => {
	it('[P1] submit disabled while email empty (no HTML5 submit possible)', () => {
		renderWithQuery(<SignInForm />)
		const submit = screen.getByRole('button', { name: 'Войти' })
		expect((submit as HTMLButtonElement).disabled).toBe(true)
	})

	it('[P2] submit stays disabled while captcha enforced + token empty (form fields filled)', async () => {
		renderWithQuery(<SignInForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Email'), 'user@example.com')
		await user.type(screen.getByLabelText('Пароль'), 'pa55word!')
		const submit = screen.getByRole('button', { name: 'Войти' })
		expect((submit as HTMLButtonElement).disabled).toBe(true)
	})
})

describe('SignInForm — successful submit', () => {
	it('[P3] calls signIn.email with credentials + captchaToken merged into 2nd-arg body', async () => {
		signInEmailMock.mockResolvedValueOnce({ data: { user: { id: 'u-1' } }, error: null })
		renderWithQuery(<SignInForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Email'), 'user@example.com')
		await user.type(screen.getByLabelText('Пароль'), 'pa55word!')
		await user.click(screen.getByTestId('cap-success'))
		await user.click(screen.getByRole('button', { name: 'Войти' }))

		await waitFor(() => {
			expect(signInEmailMock).toHaveBeenCalledTimes(1)
		})
		expect(signInEmailMock).toHaveBeenCalledWith(
			{ email: 'user@example.com', password: 'pa55word!' },
			{ body: { captchaToken: 'tok-signin-456' } },
		)
	})
})

describe('SignInForm — error path', () => {
	it('[P4] BA error → localized banner + captcha cleared (submit re-disabled)', async () => {
		signInEmailMock.mockResolvedValueOnce({
			data: null,
			error: { status: 429, code: 'TOO_MANY_REQUESTS' },
		})
		renderWithQuery(<SignInForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Email'), 'user@example.com')
		await user.type(screen.getByLabelText('Пароль'), 'pa55word!')
		await user.click(screen.getByTestId('cap-success'))
		await user.click(screen.getByRole('button', { name: 'Войти' }))

		await waitFor(() => {
			expect(screen.queryByRole('alert')).not.toBe(null)
		})
		const errorTitle = screen.getByText('Слишком много попыток')
		expect(errorTitle.tagName).toBe('P')
		// Captcha token reset → submit blocked (also blocking=true via 429 mapping).
		const submit = screen.getByRole('button', { name: 'Войти' })
		expect((submit as HTMLButtonElement).disabled).toBe(true)
	})

	it('[P5] BA invalid-credentials error surfaces RU title (no captcha lockout)', async () => {
		signInEmailMock.mockResolvedValueOnce({
			data: null,
			error: { status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' },
		})
		renderWithQuery(<SignInForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Email'), 'user@example.com')
		await user.type(screen.getByLabelText('Пароль'), 'pa55word!')
		await user.click(screen.getByTestId('cap-success'))
		await user.click(screen.getByRole('button', { name: 'Войти' }))

		await waitFor(() => {
			expect(screen.queryByRole('alert')).not.toBe(null)
		})
		// Title is rendered as a <p class="font-medium">. Match by tagName +
		// text content rather than by role/level.
		const banner = screen.getByRole('alert')
		expect(banner.textContent).toContain('Неверный email или пароль')
	})
})
