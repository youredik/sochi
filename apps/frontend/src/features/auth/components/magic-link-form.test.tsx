/**
 * MagicLinkForm — strict tests.
 *
 * Pre-done audit:
 *   [R1] form renders email input + submit button with «Получить ссылку для входа»
 *   [R2] CaptchaField rendered when captchaEnforced (mocked true)
 *   [P1] submit disabled while email empty
 *   [P2] submit disabled while captcha enforced + no token
 *   [P3] submit with email + token → magicLink called with {email, callbackURL,
 *        captchaToken} (callbackURL absolute, prepended with window.location.origin)
 *   [P4] BA success (no error) → confirmation state with the typed email
 *   [P5] BA error → localized error banner + captcha reset (submit re-disabled)
 *   [N1] callbackPath prop overrides the default '/'
 *
 * Mocking strategy: we mock `@/features/auth/lib/captcha` to force
 * `captchaEnforced=true` (decoupled from env-load timing which proved
 * brittle under bun:test module-cache) AND mock `CaptchaField` to surface
 * a deterministic test button. CaptchaField's own env gating is covered
 * by `captcha-field.test.tsx`, so this file focuses on form orchestration.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'

const magicLinkMock = mock()
await mock.module('@/lib/auth-client', () => ({
	authClient: { signIn: { magicLink: magicLinkMock } },
	// `use-auth-mutations.ts` imports `sessionQueryOptions` even though
	// `useSignInMagicLink` doesn't read it — surrounding hooks evaluate at
	// module load, so the export must exist.
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
				onClick: () => props.onToken('tok-xyz-789'),
			},
			'solve',
		),
}))

const { MagicLinkForm } = await import('./magic-link-form')

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

describe('MagicLinkForm — initial render', () => {
	it('[R1] renders email input + submit button with «Получить ссылку для входа» label', () => {
		renderWithQuery(<MagicLinkForm />)
		const email = screen.getByLabelText('Email') as HTMLInputElement
		expect(email.type).toBe('email')
		expect(email.required).toBe(true)
		const submit = screen.getByRole('button', { name: 'Получить ссылку для входа' })
		expect((submit as HTMLButtonElement).disabled).toBe(true) // email empty
	})

	it('[R2] renders CaptchaField when captchaEnforced=true', () => {
		renderWithQuery(<MagicLinkForm />)
		const captchaButton = screen.getByTestId('cap-success')
		expect(captchaButton.tagName).toBe('BUTTON')
		expect((captchaButton as HTMLButtonElement).type).toBe('button')
	})
})

describe('MagicLinkForm — submit gating', () => {
	it('[P1] submit disabled while email empty (no submit possible)', () => {
		renderWithQuery(<MagicLinkForm />)
		const submit = screen.getByRole('button', { name: 'Получить ссылку для входа' })
		expect((submit as HTMLButtonElement).disabled).toBe(true)
	})

	it('[P2] submit stays disabled while captcha enforced + token empty (email filled)', async () => {
		renderWithQuery(<MagicLinkForm />)
		await userEvent.setup().type(screen.getByLabelText('Email'), 'user@example.com')
		const submit = screen.getByRole('button', { name: 'Получить ссылку для входа' })
		expect((submit as HTMLButtonElement).disabled).toBe(true)
	})
})

describe('MagicLinkForm — successful submit', () => {
	it('[P3] calls magicLink with email + absolute callbackURL + captchaToken merged into body', async () => {
		magicLinkMock.mockResolvedValueOnce({ data: { status: true }, error: null })
		renderWithQuery(<MagicLinkForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Email'), 'user@example.com')
		await user.click(screen.getByTestId('cap-success'))
		await user.click(screen.getByRole('button', { name: 'Получить ссылку для входа' }))

		await waitFor(() => {
			expect(magicLinkMock).toHaveBeenCalledTimes(1)
		})
		expect(magicLinkMock).toHaveBeenCalledWith(
			{ email: 'user@example.com', callbackURL: 'http://localhost/' },
			{ body: { captchaToken: 'tok-xyz-789' } },
		)
	})

	it('[P4] success response → confirmation state with typed email rendered', async () => {
		magicLinkMock.mockResolvedValueOnce({ data: { status: true }, error: null })
		renderWithQuery(<MagicLinkForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Email'), 'jane@example.com')
		await user.click(screen.getByTestId('cap-success'))
		await user.click(screen.getByRole('button', { name: 'Получить ссылку для входа' }))

		await waitFor(() => {
			const heading = screen.getByText('Письмо отправлено')
			expect(heading.tagName).toBe('P')
		})
		// Email rendered inside a <strong> in the confirmation copy.
		const emailEl = screen.getByText('jane@example.com')
		expect(emailEl.tagName).toBe('STRONG')
		// "Resend on another email" CTA appears as a button element.
		const resendBtn = screen.getByRole('button', { name: 'Отправить на другой email' })
		expect((resendBtn as HTMLButtonElement).type).toBe('button')
	})
})

describe('MagicLinkForm — error path', () => {
	it('[P5] BA error → localized banner (mapAuthError) + captcha cleared (submit re-disabled)', async () => {
		magicLinkMock.mockResolvedValueOnce({
			data: null,
			error: { status: 429, code: 'TOO_MANY_REQUESTS' },
		})
		renderWithQuery(<MagicLinkForm />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Email'), 'user@example.com')
		await user.click(screen.getByTestId('cap-success'))
		await user.click(screen.getByRole('button', { name: 'Получить ссылку для входа' }))

		await waitFor(() => {
			expect(screen.queryByRole('alert')).not.toBe(null)
		})
		const errorTitle = screen.getByText('Слишком много попыток')
		expect(errorTitle.tagName).toBe('P')
		// Captcha token reset → submit blocked (also blocking=true via 429 mapping).
		const submit = screen.getByRole('button', { name: 'Получить ссылку для входа' })
		expect((submit as HTMLButtonElement).disabled).toBe(true)
	})
})

describe('MagicLinkForm — callbackPath prop', () => {
	it('[N1] callbackPath overrides default; absCallback prepends window.location.origin', async () => {
		magicLinkMock.mockResolvedValueOnce({ data: { status: true }, error: null })
		renderWithQuery(<MagicLinkForm callbackPath="/welcome" />)
		const user = userEvent.setup()
		await user.type(screen.getByLabelText('Email'), 'u@e.com')
		await user.click(screen.getByTestId('cap-success'))
		await user.click(screen.getByRole('button', { name: 'Получить ссылку для входа' }))

		await waitFor(() => {
			expect(magicLinkMock).toHaveBeenCalledTimes(1)
		})
		const call = magicLinkMock.mock.calls[0] as [{ callbackURL: string }, unknown]
		expect(call[0].callbackURL).toBe('http://localhost/welcome')
	})
})
