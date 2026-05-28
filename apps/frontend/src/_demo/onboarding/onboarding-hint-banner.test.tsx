/**
 * OnboardingHintBanner — pure component tests.
 *
 * Isolated test (no Bun module mocks affecting other suites). Asserts:
 *   [B1] visible=false → renders nothing (null)
 *   [B2] visible=true → renders banner с testid `demo-onboarding-hint`
 *   [B3] setup link href includes orgSlug parameter
 *   [B4] dismiss button click invokes onDismiss callback
 *   [B5] dismiss button has aria-label «Скрыть подсказку» (a11y canon)
 *   [B6] banner role=status (assistive tech announcement)
 *
 * Note: TanStack Link rendered via lightweight stub so we don't pull in
 * full router runtime для unit test. The stub matches Link's contract
 * (renders `<a href={resolved}>`).
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type * as React from 'react'

// Lightweight Link stub — local к этому test file, so the mock leak
// hits ONLY this suite when run в parallel. We use `mock.module` для
// the import but it's namespaced — TanStack router-using suites не
// touched since we only stub here, before importing the component.
mock.module('@tanstack/react-router', () => ({
	Link: ({
		to,
		params,
		children,
		className,
		'data-testid': testid,
	}: {
		to: string
		params?: Record<string, string>
		children: React.ReactNode
		className?: string
		'data-testid'?: string
	}) => {
		const href = to.replace(/\$(\w+)/g, (_, key) => params?.[key] ?? `$${key}`)
		return (
			<a href={href} className={className} data-testid={testid}>
				{children}
			</a>
		)
	},
}))

const { OnboardingHintBanner } = await import('./onboarding-hint-banner.tsx')

afterEach(() => {
	cleanup()
})

describe('OnboardingHintBanner — pure component', () => {
	it('[B1] visible=false → renders nothing', () => {
		const { container } = render(
			<OnboardingHintBanner visible={false} orgSlug="hotel-romashka" onDismiss={() => {}} />,
		)
		expect(container.firstChild).toBe(null)
	})

	it('[B2] visible=true → renders banner с testid demo-onboarding-hint', () => {
		render(<OnboardingHintBanner visible={true} orgSlug="hotel-romashka" onDismiss={() => {}} />)
		const banner = screen.getByTestId('demo-onboarding-hint')
		expect(banner).not.toBe(null)
		expect(banner.getAttribute('role')).toBe('status')
	})

	it('[B3] setup link href includes orgSlug parameter', () => {
		render(<OnboardingHintBanner visible={true} orgSlug="hotel-romashka" onDismiss={() => {}} />)
		const link = screen.getByTestId('demo-onboarding-setup-link')
		expect(link.getAttribute('href')).toBe('/o/hotel-romashka/setup')
	})

	it('[B4] dismiss button click invokes onDismiss callback', async () => {
		const onDismiss = mock()
		render(<OnboardingHintBanner visible={true} orgSlug="any" onDismiss={onDismiss} />)
		const dismissBtn = screen.getByLabelText('Скрыть подсказку')
		await userEvent.setup().click(dismissBtn)
		expect(onDismiss).toHaveBeenCalledTimes(1)
	})

	it('[B5] dismiss button has aria-label «Скрыть подсказку» (a11y canon)', () => {
		render(<OnboardingHintBanner visible={true} orgSlug="any" onDismiss={() => {}} />)
		const dismissBtn = screen.getByLabelText('Скрыть подсказку')
		expect(dismissBtn.tagName).toBe('BUTTON')
	})

	it('[B6] different orgSlug produces different href (тест variability)', () => {
		render(<OnboardingHintBanner visible={true} orgSlug="some-other-hotel" onDismiss={() => {}} />)
		const link = screen.getByTestId('demo-onboarding-setup-link')
		expect(link.getAttribute('href')).toBe('/o/some-other-hotel/setup')
	})
})
