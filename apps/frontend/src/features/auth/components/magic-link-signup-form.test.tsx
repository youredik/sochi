/**
 * MagicLinkSignUpForm — strict tests (passwordless canon 2026-05-13 per
 * `[[auth-passwordless-canon]]` + Round 14.6.2 «DaData party wins» canon
 * 2026-05-22 — orgName dropped from signup form per
 * `feedback_round_14_6_per_tenant_demo_canon_2026_05_28.md` Phase 14.6.2).
 *
 * Pre-done audit:
 *   [R1] form renders email input + consent checkbox + captcha widget +
 *        «Получить ссылку для регистрации» submit. No orgName field
 *        (Round 14.6.2 — DaData supplies legal name in setup wizard).
 *   [R2] CaptchaField rendered when captchaEnforced (mocked true)
 *   [P1] submit disabled while email empty
 *   [P2] submit disabled while consent unchecked (152-ФЗ hard gate)
 *   [P3] submit disabled while captcha enforced + token empty
 *   [P4] happy path: signIn.magicLink called с email + callbackURL
 *        `/welcome` (no `?n=…` param) + captchaToken merged into body
 *        per captchaFetchOptions canon
 *   [P5] success → confirmation state с typed email rendered for
 *        re-confirmation + copy referencing ИНН next step
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
await mock.module('@/lib/auth-client', () => ({
	authClient: { signIn: { magicLink: magicLinkMock } },
	sessionQueryOptions: { queryKey: ['auth', 'session'] as const },
}))

await mock.module('@/features/auth/lib/captcha', () => ({
	captchaEnforced: true,
}))

await mock.module('@/features/auth/components/captcha-field', () => ({
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

await mock.module('@tanstack/react-router', () => ({
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
	it('[R1] renders email input + consent checkbox + submit; NO orgName field', () => {
		renderWithQuery(<MagicLinkSignUpForm />)
		const email = screen.getByLabelText('Email') as HTMLInputElement
		expect(email.type).toBe('email')
		expect(email.required).toBe(true)
		// Round 14.6.2 — orgName field dropped per DaData party wins canon.
		// Asserting its absence prevents accidental re-introduction.
		expect(screen.queryByLabelText('Название гостиницы')).toBe(null)
		const submit = screen.getByRole('button', { name: 'Получить ссылку для регистрации' })
		expect((submit as HTMLButtonElement).disabled).toBe(true) // every gate empty
	})

	it('[R2] renders CaptchaField when captchaEnforced=true', () => {
		renderWithQuery(<MagicLinkSignUpForm />)
		const captchaButton = screen.getByTestId('cap-success')
		expect(captchaButton.tagName).toBe('BUTTON')
		expect((captchaButton as HTMLButtonElement).type).toBe('button')
	})
})

describe('MagicLinkSignUpForm — submit gating', () => {
	it('[P1] submit disabled while email empty', async () => {
		renderWithQuery(<MagicLinkSignUpForm />)
		const user = userEvent.setup()
		await user.click(screen.getByLabelText(/согласие/))
		await user.click(screen.getByTestId('cap-success'))
		const submit = screen.getByRole('button', { name: 'Получить ссылку для регистрации' })
		expect((submit as HTMLButtonElement).disabled).toBe(true)
	})

	it('[P2] submit disabled while consent unchecked (152-ФЗ hard gate)', async () => {
		renderWithQuery(<MagicLinkSignUpForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Email'), 'jane@example.com')
		await user.click(screen.getByTestId('cap-success'))
		// Deliberately NOT checking consent.
		const submit = screen.getByRole('button', { name: 'Получить ссылку для регистрации' })
		expect((submit as HTMLButtonElement).disabled).toBe(true)
	})

	it('[P3] submit disabled while captcha enforced + token empty', async () => {
		renderWithQuery(<MagicLinkSignUpForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Email'), 'jane@example.com')
		await user.click(screen.getByLabelText(/согласие/))
		const submit = screen.getByRole('button', { name: 'Получить ссылку для регистрации' })
		expect((submit as HTMLButtonElement).disabled).toBe(true)
	})
})

describe('MagicLinkSignUpForm — successful submit', () => {
	it('[P4] calls signIn.magicLink с email + callbackURL=/welcome + captchaToken in 2nd-arg body', async () => {
		magicLinkMock.mockResolvedValueOnce({ data: { status: true }, error: null })
		renderWithQuery(<MagicLinkSignUpForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Email'), 'jane@example.com')
		await user.click(screen.getByLabelText(/согласие/))
		await user.click(screen.getByTestId('cap-success'))
		await user.click(screen.getByRole('button', { name: 'Получить ссылку для регистрации' }))

		await waitFor(() => {
			expect(magicLinkMock).toHaveBeenCalledTimes(1)
		})
		// Round 14.6.2 — callbackURL has no `?n=` param (orgName dropped).
		const expectedCallback = 'http://localhost/welcome'
		expect(magicLinkMock).toHaveBeenCalledWith(
			{ email: 'jane@example.com', callbackURL: expectedCallback },
			{ body: { captchaToken: 'tok-signup-magic-789' } },
		)
	})

	it('[P5] success → confirmation state с typed email + ИНН next-step copy', async () => {
		magicLinkMock.mockResolvedValueOnce({ data: { status: true }, error: null })
		renderWithQuery(<MagicLinkSignUpForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Email'), 'jane@example.com')
		await user.click(screen.getByLabelText(/согласие/))
		await user.click(screen.getByTestId('cap-success'))
		await user.click(screen.getByRole('button', { name: 'Получить ссылку для регистрации' }))

		await waitFor(() => {
			expect(screen.queryByText('Письмо отправлено')).not.toBe(null)
		})
		// Email rendered inside <strong> для re-verification before clicking
		// the magic-link in inbox.
		const emailEl = screen.getByText('jane@example.com')
		expect(emailEl.tagName).toBe('STRONG')
		// Round 14.6.2 — copy now mentions ИНН next step (no orgName).
		const copyEl = screen.getByText(/ИНН/)
		expect(copyEl).not.toBe(null)
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
