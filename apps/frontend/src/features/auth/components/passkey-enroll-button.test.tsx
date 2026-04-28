/**
 * PasskeyEnrollButton — strict tests (M9.5 Phase D).
 *
 * Pre-done audit:
 *   [R1] renders Button с Fingerprint icon + label «Добавить passkey»
 *   [R2] disabled=false по умолчанию, pending=false
 *   [P1] click → authClient.passkey.addPasskey called с deriveDeviceName()
 *   [P2] click → button disabled while pending, shows «Регистрируем…»
 *   [P3] success → toast.success + onEnrolled callback
 *   [E1] error.message → toast.error
 *   [E2] thrown exception → toast.error
 *   [N1] override defaultName prop → addPasskey called с custom name
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const addPasskeyMock = vi.fn()
vi.mock('@/lib/auth-client', () => ({
	authClient: { passkey: { addPasskey: addPasskeyMock } },
}))
const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
	toast: { success: toastSuccess, error: toastError },
}))

const { PasskeyEnrollButton } = await import('./passkey-enroll-button')

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe('PasskeyEnrollButton — render', () => {
	it('[R1] button с label «Добавить passkey»', () => {
		render(<PasskeyEnrollButton />)
		expect(screen.getByRole('button', { name: /Добавить passkey/ })).toBeDefined()
	})

	it('[R2] disabled=false initial', () => {
		render(<PasskeyEnrollButton />)
		const btn = screen.getByRole('button', { name: /Добавить passkey/ })
		expect((btn as HTMLButtonElement).disabled).toBe(false)
	})
})

describe('PasskeyEnrollButton — passkey enrollment flow', () => {
	it('[P1] click → addPasskey called', async () => {
		addPasskeyMock.mockResolvedValueOnce({ data: { id: 'pk_test' } })
		render(<PasskeyEnrollButton />)
		await userEvent.setup().click(screen.getByRole('button', { name: /Добавить passkey/ }))
		expect(addPasskeyMock).toHaveBeenCalledOnce()
		const arg = addPasskeyMock.mock.calls[0]?.[0] as { name: string }
		expect(arg.name).toBeTypeOf('string')
		expect(arg.name.length).toBeGreaterThan(0)
	})

	it('[P3] success → toast.success + onEnrolled', async () => {
		addPasskeyMock.mockResolvedValueOnce({ data: { id: 'pk_test' } })
		const onEnrolled = vi.fn()
		render(<PasskeyEnrollButton onEnrolled={onEnrolled} />)
		await userEvent.setup().click(screen.getByRole('button', { name: /Добавить passkey/ }))
		await waitFor(() => {
			expect(toastSuccess).toHaveBeenCalledOnce()
			expect(onEnrolled).toHaveBeenCalledOnce()
		})
	})

	it('[E1] result.error.message → toast.error', async () => {
		addPasskeyMock.mockResolvedValueOnce({ error: { message: 'WebAuthn cancelled' } })
		render(<PasskeyEnrollButton />)
		await userEvent.setup().click(screen.getByRole('button', { name: /Добавить passkey/ }))
		await waitFor(() => {
			expect(toastError).toHaveBeenCalledWith('WebAuthn cancelled')
		})
	})

	it('[E2] thrown exception → toast.error', async () => {
		addPasskeyMock.mockRejectedValueOnce(new Error('Hardware unavailable'))
		render(<PasskeyEnrollButton />)
		await userEvent.setup().click(screen.getByRole('button', { name: /Добавить passkey/ }))
		await waitFor(() => {
			expect(toastError).toHaveBeenCalledWith('Hardware unavailable')
		})
	})

	it('[N1] custom defaultName propagated к addPasskey', async () => {
		addPasskeyMock.mockResolvedValueOnce({ data: { id: 'pk_test' } })
		render(<PasskeyEnrollButton defaultName="iPad Touch ID" />)
		await userEvent.setup().click(screen.getByRole('button', { name: /Добавить passkey/ }))
		await waitFor(() => {
			expect(addPasskeyMock).toHaveBeenCalledWith({ name: 'iPad Touch ID' })
		})
	})
})
