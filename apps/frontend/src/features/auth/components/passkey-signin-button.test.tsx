/**
 * PasskeySigninButton — strict tests (M9.5 Phase D).
 *
 * Pre-done audit:
 *   [R1] renders Button с label «Войти через passkey»
 *   [P1] click → authClient.signIn.passkey called
 *   [P2] success → onSuccess callback fires
 *   [E1] result.error.message → toast.error
 *   [E2] thrown exception → toast.error
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const signInPasskeyMock = vi.fn()
vi.mock('@/lib/auth-client', () => ({
	authClient: { signIn: { passkey: signInPasskeyMock } },
}))
const toastError = vi.fn()
vi.mock('sonner', () => ({
	toast: { error: toastError, success: vi.fn() },
}))

const { PasskeySigninButton } = await import('./passkey-signin-button')

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe('PasskeySigninButton', () => {
	it('[R1] button label «Войти через passkey»', () => {
		render(<PasskeySigninButton />)
		expect(screen.getByRole('button', { name: /Войти через passkey/ })).toBeDefined()
	})

	it('[P1] click → signIn.passkey called', async () => {
		signInPasskeyMock.mockResolvedValueOnce({ data: { user: { id: 'usr_x' } } })
		render(<PasskeySigninButton />)
		await userEvent.setup().click(screen.getByRole('button', { name: /Войти через passkey/ }))
		expect(signInPasskeyMock).toHaveBeenCalledOnce()
	})

	it('[P2] success → onSuccess fires', async () => {
		signInPasskeyMock.mockResolvedValueOnce({ data: { user: { id: 'usr_x' } } })
		const onSuccess = vi.fn()
		render(<PasskeySigninButton onSuccess={onSuccess} />)
		await userEvent.setup().click(screen.getByRole('button', { name: /Войти через passkey/ }))
		await waitFor(() => {
			expect(onSuccess).toHaveBeenCalledOnce()
		})
	})

	it('[E1] result.error.message → toast.error', async () => {
		signInPasskeyMock.mockResolvedValueOnce({ error: { message: 'No credential' } })
		render(<PasskeySigninButton />)
		await userEvent.setup().click(screen.getByRole('button', { name: /Войти через passkey/ }))
		await waitFor(() => {
			expect(toastError).toHaveBeenCalledWith('No credential')
		})
	})

	it('[E2] thrown exception → toast.error', async () => {
		signInPasskeyMock.mockRejectedValueOnce(new Error('Browser cancelled'))
		render(<PasskeySigninButton />)
		await userEvent.setup().click(screen.getByRole('button', { name: /Войти через passkey/ }))
		await waitFor(() => {
			expect(toastError).toHaveBeenCalledWith('Browser cancelled')
		})
	})
})
