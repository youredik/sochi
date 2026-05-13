/**
 * CaptchaField — strict tests.
 *
 * Pre-done audit:
 *   [R1] siteKey absent (env unset)  → renders nothing (firstChild === null)
 *   [R2] siteKey present             → renders SmartCaptcha widget
 *   [P1] widget onSuccess('tok123')  → onToken called with exactly 'tok123'
 *   [P2] widget onTokenExpired       → onToken called with exactly ''
 *   [P3] widget onNetworkError       → onToken called with exactly ''
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'

mock.module('@yandex/smart-captcha', () => ({
	SmartCaptcha: (props: {
		onSuccess?: (token: string) => void
		onTokenExpired?: () => void
		onNetworkError?: () => void
		sitekey: string
		language?: string
	}) =>
		React.createElement('div', { 'data-testid': 'smart-captcha', 'data-sitekey': props.sitekey }, [
			React.createElement(
				'button',
				{
					key: 'success',
					type: 'button',
					'data-testid': 'cap-success',
					onClick: () => props.onSuccess?.('tok123'),
				},
				'success',
			),
			React.createElement(
				'button',
				{
					key: 'expired',
					type: 'button',
					'data-testid': 'cap-expired',
					onClick: () => props.onTokenExpired?.(),
				},
				'expired',
			),
			React.createElement(
				'button',
				{
					key: 'network',
					type: 'button',
					'data-testid': 'cap-network',
					onClick: () => props.onNetworkError?.(),
				},
				'network',
			),
		]),
}))

const { CaptchaField } = await import('./captcha-field')

const ORIGINAL_SITE_KEY = import.meta.env.VITE_YANDEX_CAPTCHA_SITE_KEY

function setSiteKey(value: string | undefined) {
	;(import.meta.env as Record<string, unknown>).VITE_YANDEX_CAPTCHA_SITE_KEY = value
}

beforeEach(() => {
	setSiteKey('ymsk_test_site_key_42')
})

afterEach(() => {
	cleanup()
	mock.clearAllMocks()
	setSiteKey(ORIGINAL_SITE_KEY)
})

describe('CaptchaField — render gating', () => {
	it('[R1] returns null when VITE_YANDEX_CAPTCHA_SITE_KEY is unset', () => {
		setSiteKey(undefined)
		const onToken = mock()
		const { container } = render(<CaptchaField onToken={onToken} />)
		expect(container.firstChild).toBe(null)
		expect(onToken).toHaveBeenCalledTimes(0)
	})

	it('[R1.adversarial] returns null when env value is an empty string (CI misconfig)', () => {
		setSiteKey('')
		const onToken = mock()
		const { container } = render(<CaptchaField onToken={onToken} />)
		expect(container.firstChild).toBe(null)
		expect(onToken).toHaveBeenCalledTimes(0)
	})

	it('[R2] renders SmartCaptcha with sitekey wired through when env set', () => {
		const onToken = mock()
		render(<CaptchaField onToken={onToken} />)
		const widget = screen.getByTestId('smart-captcha')
		expect(widget.getAttribute('data-sitekey')).toBe('ymsk_test_site_key_42')
	})
})

describe('CaptchaField — token callback wiring', () => {
	it('[P1] widget onSuccess propagates exact token to onToken', async () => {
		const onToken = mock()
		render(<CaptchaField onToken={onToken} />)
		await userEvent.setup().click(screen.getByTestId('cap-success'))
		expect(onToken).toHaveBeenCalledTimes(1)
		expect(onToken).toHaveBeenCalledWith('tok123')
	})

	it('[P2] widget onTokenExpired clears token to empty string', async () => {
		const onToken = mock()
		render(<CaptchaField onToken={onToken} />)
		await userEvent.setup().click(screen.getByTestId('cap-expired'))
		expect(onToken).toHaveBeenCalledTimes(1)
		expect(onToken).toHaveBeenCalledWith('')
	})

	it('[P3] widget onNetworkError clears token to empty string', async () => {
		const onToken = mock()
		render(<CaptchaField onToken={onToken} />)
		await userEvent.setup().click(screen.getByTestId('cap-network'))
		expect(onToken).toHaveBeenCalledTimes(1)
		expect(onToken).toHaveBeenCalledWith('')
	})
})
