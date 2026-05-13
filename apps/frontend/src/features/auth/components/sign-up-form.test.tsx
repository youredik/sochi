/**
 * SignUpForm — strict tests.
 *
 * Pre-done audit:
 *   [R1] form renders 4 inputs (name/email/password/orgName) + consent
 *        checkbox + «Создать аккаунт» submit
 *   [R2] CaptchaField rendered when captchaEnforced (mocked true)
 *   [R3] slug preview updates live с типизацией orgName
 *   [P1] submit disabled while captcha enforced + token empty
 *   [P2] submit с unchecked consent → useSignUp local-reject, no network
 *        call к authClient (защита 152-ФЗ перед самым первым byte)
 *   [P3] full happy path: signUp.email + organization.create both called,
 *        captchaToken merged into the 2nd-arg body of signUp.email per
 *        captchaFetchOptions canon
 *   [P4] BA error → localized banner + captcha cleared (next attempt
 *        requires fresh challenge per single-use Yandex SmartCaptcha token)
 *
 * Mocking strategy mirrors `magic-link-form.test.tsx` /
 * `sign-in-form.test.tsx`: force `captchaEnforced=true` (decoupled from env
 * timing per `[[bun-test-canons-2026-05-13]]`) AND stub CaptchaField as a
 * deterministic test button. CaptchaField's env gating covered separately
 * by `captcha-field.test.tsx`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'

const signUpEmailMock = mock()
const organizationCreateMock = mock()
mock.module('@/lib/auth-client', () => ({
	authClient: {
		signUp: { email: signUpEmailMock },
		organization: { create: organizationCreateMock },
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
				onClick: () => props.onToken('tok-signup-123'),
			},
			'solve',
		),
}))

mock.module('@tanstack/react-router', () => ({
	Link: (props: { children: React.ReactNode; to: string }) =>
		React.createElement('a', { href: props.to }, props.children),
	useNavigate: () => () => {},
}))

const { SignUpForm } = await import('./sign-up-form')

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

describe('SignUpForm — initial render', () => {
	it('[R1] renders 4 inputs + consent checkbox + Создать аккаунт submit', () => {
		renderWithQuery(<SignUpForm />)
		const name = screen.getByLabelText('Ваше имя') as HTMLInputElement
		expect(name.type).toBe('text')
		expect(name.required).toBe(true)
		const email = screen.getByLabelText('Email') as HTMLInputElement
		expect(email.type).toBe('email')
		expect(email.required).toBe(true)
		const password = screen.getByLabelText('Пароль') as HTMLInputElement
		expect(password.type).toBe('password')
		expect(password.minLength).toBe(8)
		const orgName = screen.getByLabelText('Название гостиницы') as HTMLInputElement
		expect(orgName.type).toBe('text')
		expect(orgName.required).toBe(true)
		const submit = screen.getByRole('button', { name: 'Создать аккаунт' })
		expect((submit as HTMLButtonElement).disabled).toBe(true) // token empty
	})

	it('[R2] renders CaptchaField when captchaEnforced=true', () => {
		renderWithQuery(<SignUpForm />)
		const captchaButton = screen.getByTestId('cap-success')
		expect(captchaButton.tagName).toBe('BUTTON')
		expect((captchaButton as HTMLButtonElement).type).toBe('button')
	})

	it('[R3] slug preview updates как user печатает orgName (live transform)', async () => {
		renderWithQuery(<SignUpForm />)
		await userEvent.setup().type(screen.getByLabelText('Название гостиницы'), 'Гостиница Ромашка')
		// Slug rendered inside a <span class="font-mono"> sibling to the input.
		const slugSpan = screen.getByText(/\/o\//)
		// Two well-known facts about slugify('Гостиница Ромашка'):
		//   - the Russian → Latin transliteration runs (не remains Cyrillic)
		//   - the result is lower-case kebab-case
		expect(slugSpan.textContent?.startsWith('/o/')).toBe(true)
		expect(slugSpan.textContent).not.toBe('/o/…')
	})
})

describe('SignUpForm — submit gating', () => {
	it('[P1] submit disabled while captcha enforced + token empty (form fields filled)', async () => {
		renderWithQuery(<SignUpForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Ваше имя'), 'Jane Doe')
		await user.type(screen.getByLabelText('Email'), 'jane@example.com')
		await user.type(screen.getByLabelText('Пароль'), 'pa55word!')
		await user.type(screen.getByLabelText('Название гостиницы'), 'Гостиница')
		await user.click(screen.getByLabelText(/согласие/))
		const submit = screen.getByRole('button', { name: 'Создать аккаунт' })
		expect((submit as HTMLButtonElement).disabled).toBe(true)
	})

	it('[P2] submit без consent → useSignUp local-rejects, no network call', async () => {
		renderWithQuery(<SignUpForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Ваше имя'), 'Jane Doe')
		await user.type(screen.getByLabelText('Email'), 'jane@example.com')
		await user.type(screen.getByLabelText('Пароль'), 'pa55word!')
		await user.type(screen.getByLabelText('Название гостиницы'), 'Гостиница')
		await user.click(screen.getByTestId('cap-success'))
		// Deliberately NOT checking consent.
		await user.click(screen.getByRole('button', { name: 'Создать аккаунт' }))

		await waitFor(() => {
			expect(screen.queryByRole('alert')).not.toBe(null)
		})
		const banner = screen.getByRole('alert')
		expect(banner.textContent).toContain('согласие на обработку персональных данных')
		// authClient.signUp.email MUST NOT be called when consent rejected
		// locally (защита 152-ФЗ на самом раннем seam).
		expect(signUpEmailMock).toHaveBeenCalledTimes(0)
		expect(organizationCreateMock).toHaveBeenCalledTimes(0)
	})
})

describe('SignUpForm — successful submit', () => {
	it('[P3] happy path: signUp.email + organization.create called; captchaToken merged into 2nd-arg body', async () => {
		signUpEmailMock.mockResolvedValueOnce({ data: { user: { id: 'u-1' } }, error: null })
		organizationCreateMock.mockResolvedValueOnce({
			data: { id: 'org-1', slug: 'gostinitsa-romashka' },
			error: null,
		})
		renderWithQuery(<SignUpForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Ваше имя'), 'Jane Doe')
		await user.type(screen.getByLabelText('Email'), 'jane@example.com')
		await user.type(screen.getByLabelText('Пароль'), 'pa55word!')
		await user.type(screen.getByLabelText('Название гостиницы'), 'Гостиница Ромашка')
		await user.click(screen.getByLabelText(/согласие/))
		await user.click(screen.getByTestId('cap-success'))
		await user.click(screen.getByRole('button', { name: 'Создать аккаунт' }))

		await waitFor(() => {
			expect(signUpEmailMock).toHaveBeenCalledTimes(1)
		})
		expect(signUpEmailMock).toHaveBeenCalledWith(
			{ name: 'Jane Doe', email: 'jane@example.com', password: 'pa55word!' },
			{ body: { captchaToken: 'tok-signup-123' } },
		)
		await waitFor(() => {
			expect(organizationCreateMock).toHaveBeenCalledTimes(1)
		})
		// First positional arg к organization.create — at least name passed.
		const orgCall = organizationCreateMock.mock.calls[0] as [{ name: string; slug: string }]
		expect(orgCall[0].name).toBe('Гостиница Ромашка')
		expect(orgCall[0].slug.length > 0).toBe(true)
	})
})

describe('SignUpForm — error path', () => {
	it('[P4] BA signUp error → localized banner + captcha cleared (submit re-disabled)', async () => {
		signUpEmailMock.mockResolvedValueOnce({
			data: null,
			error: { status: 429, code: 'TOO_MANY_REQUESTS' },
		})
		renderWithQuery(<SignUpForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Ваше имя'), 'Jane Doe')
		await user.type(screen.getByLabelText('Email'), 'jane@example.com')
		await user.type(screen.getByLabelText('Пароль'), 'pa55word!')
		await user.type(screen.getByLabelText('Название гостиницы'), 'Гостиница')
		await user.click(screen.getByLabelText(/согласие/))
		await user.click(screen.getByTestId('cap-success'))
		await user.click(screen.getByRole('button', { name: 'Создать аккаунт' }))

		await waitFor(() => {
			expect(screen.queryByRole('alert')).not.toBe(null)
		})
		const errorTitle = screen.getByText('Слишком много попыток')
		expect(errorTitle.tagName).toBe('P')
		const submit = screen.getByRole('button', { name: 'Создать аккаунт' })
		expect((submit as HTMLButtonElement).disabled).toBe(true)
	})
})
